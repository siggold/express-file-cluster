# `ignite(config)` — API Reference

`ignite()` is the single entry point that boots the framework. It handles clustering, database, auth, tasks, and routing in the correct order.

```ts
import { ignite } from 'express-file-cluster';

const server = await ignite(config);
```

**Returns:** `Promise<http.Server | undefined>`

- Returns `http.Server` in a worker process (or in single-process mode).
- Returns `undefined` in the master process (clustering enabled, primary fork).

---

## `EFCConfig` reference

```ts
interface EFCConfig {
  // Routing
  basePath?: string;

  // Clustering
  cluster?: boolean;
  workers?: number;
  onWorkerReady?: (id: number) => void;
  onWorkerCrash?: (id: number, code: number) => void;

  // Database
  database?: 'mongodb' | 'postgresql';
  databaseUrl?: string;

  // Auth
  authStrategy?: 'http-only' | 'localStorage';
  jwtSecret?: string;
  jwtExpiresIn?: string;
  cookieDomain?: string;

  // Background tasks
  tasks?: TaskConfig | false;

  // HTTP
  port?: number;
  cors?: boolean | CorsConfig;
  globalMiddlewares?: RequestHandler[];
  onError?: ErrorRequestHandler;

  // Developer tools
  dashboard?: boolean;
}
```

---

## Option details

### `basePath`

URL prefix prepended to every route. Default: `'/v1/api'`.

```ts
ignite({ basePath: '/api' });
// routes: /api/health, /api/users/:id, ...
```

Set to `'/'` to mount routes directly at the root with no prefix.

---

### `dashboard`

When `true`, EFC mounts a live API documentation page at `GET /` (or `GET <basePath>/`) that is only active in development (`NODE_ENV === 'development'`). The page lists every registered route with its method, path, description, and request/response examples derived from each file's `meta` export.

```ts
ignite({ dashboard: true });
```

---

### `port`

HTTP listen port. Default: `3000`. `ignite()` never reads `PORT` from the environment itself — pass it explicitly, typically by reading `process.env.PORT` in `efc.config.ts` (see [Environment Variables](../guides/environment-variables.md)).

```ts
ignite({ port: 8080 });
// or, in efc.config.ts: port: process.env.PORT ? Number(process.env.PORT) : undefined
```

---

### `cluster`

Enable multi-core clustering. When `true`, the primary process forks `workers` child processes and returns `undefined`. Each worker runs the full Pre-Flight lifecycle independently.

Default: `true` when `NODE_ENV === 'production'`, `false` otherwise.

```ts
ignite({ cluster: true, workers: 4 });
```

---

### `workers`

Number of worker processes to fork. Default: `os.cpus().length`.

---

### `onWorkerReady`

Called by the primary process when a worker emits the `'online'` event.

```ts
onWorkerReady: (id) => logger.info(`Worker ${id} is live`),
```

---

### `onWorkerCrash`

Called by the primary process when a worker exits unexpectedly, before a replacement is forked. The `code` is the exit code (or `-1` if the worker was killed by a signal).

```ts
onWorkerCrash: (id, code) => alerting.send(`Worker ${id} crashed with code ${code}`),
```

---

### `database`

Database engine to connect. When omitted, EFC attempts to detect the engine from the `DATABASE_URL` format (`mongodb://...` → `'mongodb'`, `postgres://...` → `'postgresql'`).

> **`'postgresql'` is accepted by the type but not yet implemented in the runtime** (landing in Phase 2). Only `'mongodb'` (via Mongoose) works today.

---

### `databaseUrl`

Connection string for the database. `ignite()` never reads `DATABASE_URL` from the environment itself — pass it explicitly (typically `databaseUrl: process.env.DATABASE_URL` in `efc.config.ts`).

---

### `authStrategy`

How JWTs are delivered to clients:

| Value | Mechanism |
|---|---|
| `'http-only'` | `HttpOnly + Secure + SameSite=Strict` cookie named `efc_token` |
| `'localStorage'` | Token returned in response body; client attaches `Authorization: Bearer <token>` |

Default: `'http-only'`.

---

### `jwtSecret`

Secret used to sign and verify JWTs (HS256). `ignite()` never reads `JWT_SECRET` from the environment itself — pass it explicitly (typically `jwtSecret: process.env.JWT_SECRET` in `efc.config.ts`). Must be at least 32 random bytes for production use.

---

### `jwtExpiresIn`

Token lifetime, e.g. `'15m'`, `'1h'`, `'7d'`, `'30d'`. Default: `'7d'`. Pass explicitly (typically `jwtExpiresIn: process.env.JWT_EXPIRES_IN`); no environment fallback.

---

### `cookieDomain`

Cookie domain used by the `'http-only'` auth strategy. Default: unset (host-only cookie, correct for `localhost`). Pass explicitly (typically `cookieDomain: process.env.COOKIE_DOMAIN`); no environment fallback.

---

### `tasks`

Background task runtime configuration. Set to `false` (or omit) to disable the task system.

```ts
interface TaskConfig {
  backend: 'bullmq' | 'pg-boss';
  redisUrl?: string;       // BullMQ only — defaults to redis://localhost:6379
  concurrency?: number;    // Jobs processed in parallel per worker — default 5
  enqueueTimeout?: number; // Max ms enqueue() waits for Redis before rejecting — default 5000
}
```

> **`'pg-boss'` is accepted by the type but not yet implemented in the runtime** (landing in Phase 2). Only `'bullmq'` works today.

---

### `cors`

CORS configuration. Default: `true` (allow all origins). `ignite()` never reads `CORS_ORIGINS` from the environment itself — pass `cors.origin` explicitly.

```ts
ignite({
  cors: {
    // typically built from `process.env.CORS_ORIGINS?.split(',').map(o => o.trim())`
    // in efc.config.ts — pass an array (not a bare string) so per-request Origin
    // validation actually happens instead of a single static header value
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    maxAge: 86400,
  },
});
```

Set `cors: false` to skip CORS headers entirely.

```ts
interface CorsConfig {
  origin?: string | string[] | boolean;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
}
```

---

### `globalMiddlewares`

Array of Express `RequestHandler` functions applied to every route, in order, before route-level middleware.

```ts
ignite({
  globalMiddlewares: [requestLogger, rateLimiter],
});
```

---

### `onError`

Override the built-in global error handler. Receives `(err, req, res, next)`. If not provided, EFC responds with:

- `{ error: err.message, statusCode: err.statusCode }` for `HttpError` instances.
- `{ error: 'Internal Server Error', statusCode: 500 }` for all other errors.

```ts
ignite({
  onError: (err, req, res, _next) => {
    logger.error({ err, url: req.url });
    const status = (err as any).statusCode ?? 500;
    res.status(status).json({ error: err.message });
  },
});
```

---

## `gracefulShutdown(server, timeoutMs?)`

Registers `SIGTERM` and `SIGINT` handlers for clean shutdown. Pass the `http.Server` returned by `ignite()`.

```ts
ignite({ port: 3000 })
  .then(gracefulShutdown);
// or with a custom timeout:
  .then((server) => gracefulShutdown(server, 30_000));
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `server` | `http.Server \| undefined` | — | Server to close (undefined for the master process) |
| `timeoutMs` | `number` | `10_000` | Force-exit after this many milliseconds if `server.close()` hasn't finished |
