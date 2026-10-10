# express-file-cluster &nbsp;·&nbsp; `efc`

**File-based routing. Multi-core clustering. Background tasks. Zero boilerplate.**

EFC is an opinionated backend framework built on Express. Drop files in `src/api/` and they become routes. Every CPU core serves traffic automatically. Heavy work goes to a queue-backed task subsystem so requests stay fast.

> **Status: v0.4.0 (Beta).** Router (incl. catch-all/optional segments and request validation), clustering, auth, structured logging, `defineModel` on MongoDB and PostgreSQL, BullMQ and pg-boss tasks with cron, and migrations are all implemented.

---

## Why EFC

Most Express apps grow the same way: a working prototype, then a maze of `router.get(...)` calls spread across files, a clustering setup copy-pasted from a blog post, and background jobs bolted on as an afterthought. EFC collapses all of that into conventions:

| Problem | EFC's answer |
|---|---|
| Route registration ceremony | The file tree **is** the route tree |
| Single-threaded Node under load | Auto-detected CPU count → worker processes |
| Blocking work on the request path | `enqueue()` ships it to a queue; respond immediately |
| Wiring auth, DB, and middleware by hand | `ignite()` — one call bootstraps everything |
| Scattered model definitions | `defineModel()` — typed CRUD with zero ORM ceremony |
| Per-request user context in nested calls | `AsyncLocalStorage`-backed `getCurrentUser()` |

---

## Quick Start

```bash
npx create-efc-app my-api
cd my-api
efc start dev
```

The interactive scaffolder asks for language, database, auth strategy, and whether you want clustering and background tasks — then writes the boilerplate, generates a `.env` with a real `JWT_SECRET`, and runs `npm install`.

---

## Project Structure

```
my-api/
├── src/
│   ├── api/                      # Every file here is a route
│   │   ├── health.ts             # GET /health
│   │   ├── users/
│   │   │   ├── index.ts          # GET /users  •  POST /users
│   │   │   └── [id].ts           # GET /users/:id  •  DELETE /users/:id
│   │   └── posts/
│   │       └── [slug]/
│   │           └── comments.ts   # GET /posts/:slug/comments
│   ├── tasks/                    # Background jobs
│   │   ├── SendEmail.ts
│   │   └── ResizeImage.ts
│   ├── model/                    # Engine-agnostic models
│   │   └── User.ts
│   └── index.ts                  # Framework entry point
├── efc.config.ts
├── .env                          # Gitignored — JWT_SECRET auto-filled
└── .env.example
```

`src/api` and `src/tasks` are resolved by convention — they are **not** `ignite()` options. EFC probes `src/api`/`src/tasks`, then `<cwd>/api`/`<cwd>/tasks`, then `dist/api`/`dist/tasks`. You only need a different layout if you're doing something unusual.

Routing rules:

| File | URL |
|---|---|
| `api/health.ts` | `/health` |
| `api/users/index.ts` | `/users` |
| `api/users/[id].ts` | `/users/:id` |
| `api/posts/[slug]/comments.ts` | `/posts/:slug/comments` |

---

## Route Handlers

Export uppercase HTTP method names. Anything not exported returns **405 Method Not Allowed** automatically.

```ts
// src/api/users/index.ts
import type { Request, Response } from 'express';
import { User } from '../../model/User.js';

export const GET = async (req: Request, res: Response) => {
  const users = await User.find();
  res.json(users);
};

export const POST = async (req: Request, res: Response) => {
  const user = await User.create(req.body);
  res.status(201).json({ id: user.id });
};
```

```ts
// src/api/users/[id].ts
import type { Request, Response } from 'express';
import { User } from '../../model/User.js';
import { HttpError } from 'express-file-cluster';

export const GET = async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
};

export const DELETE = async (req: Request, res: Response) => {
  await User.delete(req.params.id);
  res.status(204).send();
};
```

---

## Middleware

Three tiers, each with a clear scope:

```ts
// 1. Global — applies to every request
ignite({ globalMiddlewares: [rateLimiter()] });

// 2. Route-level — applies to every handler in this file
export const middlewares = [requireAuth];

// 3. Handler-level — applies to one handler via compose()
import { compose } from 'express-file-cluster';

export const POST = compose(
  validateBody(CreateUserSchema),
  async (req, res) => { /* req.body is validated */ },
);
```

---

## Database

### `defineModel(name, schema, options?)`

Declare a typed model with a schema. EFC compiles it to a Mongoose model and wraps it in a clean CRUD surface.

```ts
// src/model/User.ts
import { defineModel } from 'express-file-cluster';

interface UserDocument {
  name: string;
  email: string;
  role: 'admin' | 'user';
  verifyToken: string;
  createdAt?: Date;
}

export const User = defineModel<UserDocument>('User', {
  name:        { type: 'string', required: true },
  email:       { type: 'string', required: true, unique: true },
  role:        { type: 'string', enum: ['admin', 'user'], default: 'user' },
  verifyToken: { type: 'string', default: '$uuid' },   // fresh UUID per document
});
```

### Schema default operator codes

Instead of a literal or a raw function, `default` also accepts a sentinel string — resolved to a fresh per-document value at schema-compile time, never baked in once:

| Code | Resolves to |
|---|---|
| `'$now'` | `new Date()` |
| `'$uuid'` | `crypto.randomUUID()` |
| `'$objectId'` | fresh Mongoose `ObjectId` |
| `'$timestamp'` | `Date.now()` (number) |
| `'$shortId'` | random 16-char base64url string |
| `'$currentUser'` | full JWT payload from the in-flight request |
| `'$currentUser.<key>'` | single field from that payload (e.g. `'$currentUser.id'`) |

Any other value is used as-is — only these exact strings are special-cased.

### Auto-increment (`sequence`)

```ts
export const Order = defineModel<OrderDocument>('Order', {
  orderNumber: { type: 'number', sequence: true, required: true },
  // sequence: 'global.orders' — explicit key to share a counter across models
});
```

`sequence` is a field option, not a `default` code — an auto-increment needs an async read-modify-write against a counters collection, but `default` resolves synchronously. It's assigned atomically in a `pre('validate')` hook, before `required` validation runs, so the field can be both `required: true` and auto-filled. Top-level fields only.

### Timestamps control

```ts
// Disable Mongoose's automatic createdAt/updatedAt (default: on)
export const Role = defineModel<RoleDocument>('Role', schema, {
  timestamps: false,
});

// Or rename them
export const Audit = defineModel<AuditDocument>('Audit', schema, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
});
```

### Model API — identical on MongoDB and PostgreSQL

```ts
await User.find({ role: { $in: ['admin', 'editor'] }, 'address.city': 'Oslo' },
                { sort: { createdAt: -1 }, limit: 20, skip: 20, select: ['name'], populate: 'team' });
await User.findById(id);                         // malformed id → null
await User.findOne({ email: 'a@b.com' });
await User.create({ name: 'Alice' });            // validated (400 ModelValidationError / 409 duplicate)
await User.createMany([...]);
await User.update(id, { $inc: { logins: 1 } });  // validated too
await User.updateMany(filter, update);           // → count
await User.delete(id);
await User.deleteMany(filter);                   // → count
await User.count(filter);
await transaction(async () => { /* model calls here share one transaction */ });
```

The engine follows `DATABASE_URL` (`mongodb://` → mongoose, `postgres://` → Drizzle; install `mongoose` or `pg drizzle-orm`). Tables and indexes come from `Model.sync()` in a migration — `efc db migrate`. MongoDB-only extras: `aggregate()`, TTL indexes. `Model.raw()` returns the native mongoose model / Drizzle table.

---

## Background Tasks

Tasks run off the request path — respond immediately, let the queue handle the work.

```ts
// src/tasks/SendEmail.ts
import { defineTask } from 'express-file-cluster/tasks';

interface Payload { to: string; subject: string; body: string }

export default defineTask<Payload>(async (payload) => {
  await mailer.send(payload);
});
```

```ts
// src/tasks/ResizeImage.ts — CPU-bound: runs in a worker_threads thread
import { defineTask } from 'express-file-cluster/tasks';

export default defineTask<{ key: string; width: number }>(
  { thread: true },
  async ({ key, width }) => {
    const buf = await sharp(await download(key)).resize(width).toBuffer();
    await upload(`${key}@${width}`, buf);
  },
);
```

```ts
// Trigger from a route handler
import { enqueue } from 'express-file-cluster/tasks';

export const POST = async (req, res) => {
  const user = await User.create(req.body);
  await enqueue('SendEmail', { to: user.email, subject: 'Welcome!', body: '...' });
  res.status(202).json({ id: user.id, queued: true });
};
```

Task options:

| Option | Default | Description |
|---|---|---|
| `thread` | `false` | Run in a `worker_threads` thread (CPU-bound work) |
| `retries` | `3` | Re-runs after a failure (up to `retries + 1` attempts) before dead-lettering |
| `backoff` | `'exponential'` | Delay strategy between retries |
| `concurrency` | `tasks.concurrency` | Parallel jobs for this task |
| `schedule` | — | Cron pattern for recurring runs (payload `{}`) |
| `timezone` | server time | IANA timezone for `schedule` |

Backends: `tasks: { backend: 'bullmq', redisUrl }` or `tasks: { backend: 'pg-boss' }` (jobs in your PostgreSQL). `enqueue()` rejects after `tasks.enqueueTimeout` (default 5 s) instead of hanging when the backend is down. Dead letters: `efc tasks failed | retry | purge`.

---

## Authentication

### `http-only` (recommended for SSR/SSG)

Tokens stored in `HttpOnly + Secure + SameSite=Strict` cookies.

```ts
import { issueToken, revokeToken, requireAuth } from 'express-file-cluster/auth';

// src/api/auth/login.ts
export const POST = async (req, res) => {
  const user = await verifyCredentials(req.body);
  issueToken(res, { sub: user.id, role: user.role });
  res.json({ message: 'Logged in' });
};

// Protect a route
export const middlewares = [requireAuth];
```

### `localStorage` (SPA-friendly)

Token returned in body; client attaches `Authorization: Bearer <token>`.

```ts
import { signToken } from 'express-file-cluster/auth';

export const POST = async (req, res) => {
  const token = signToken({ sub: user.id });
  res.json({ token });
};
```

### Role-gating and request context

```ts
// Role-gated route
export const middlewares = [requireAuth('admin')];

// Real logout (needs `cache` in ignite()): the token is rejected from now on.
import { revokeSession, revokeAllSessions } from 'express-file-cluster/auth';
await revokeSession(req, res);   // this device
await revokeAllSessions(userId); // every device

// getCurrentUser() reads the same verified JWT payload from anywhere in the
// async call chain — not just where `req` is in scope. This is also what
// powers the '$currentUser' / '$currentUser.<key>' defineModel default codes.
import { getCurrentUser } from 'express-file-cluster/auth';

const user = getCurrentUser(); // Record<string, unknown> | undefined
```

---

## Bootstrapper

Every runtime value (`PORT`, `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, ...) is read from `process.env` explicitly, once, in `efc.config.ts` — `ignite()` itself never touches `process.env` (`NODE_ENV` is the sole exception).

```ts
// efc.config.ts
import type { EFCConfig } from 'express-file-cluster';

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

const config: EFCConfig = {
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  cors: corsOrigins ? { origin: corsOrigins } : true,
  authStrategy: 'http-only',
  tasks: { backend: 'bullmq', concurrency: 5, redisUrl: process.env.REDIS_URL },
};

export default config;
```

```ts
// src/index.ts
import { ignite, gracefulShutdown } from 'express-file-cluster';
import config from '../efc.config.js';

ignite({
  ...config,
}).then(gracefulShutdown).catch(console.error);
```

> Don't hardcode `cluster: true` here. `ignite()`'s own default (`NODE_ENV === 'production'`)
> already gives clustering in prod and a single process in dev — an explicit boolean always
> wins over that default, so `cluster: true` would cluster in dev too. Only pass `cluster`
> to force one way regardless of `NODE_ENV`.

### `ignite()` options

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | HTTP listen port |
| `basePath` | `string` | `'/v1/api'` | URL prefix for all routes |
| `database` | `'mongodb' \| 'postgresql'` | auto-detected from `databaseUrl` | Database engine |
| `databaseUrl` | `string` | — | Connection string — not read from env automatically, pass it explicitly |
| `authStrategy` | `'http-only' \| 'localStorage'` | `'http-only'` | Token delivery |
| `jwtSecret` | `string` | — | JWT signing secret — not read from env automatically, pass it explicitly |
| `jwtExpiresIn` | `string` | `'7d'` | Token lifetime |
| `cookieDomain` | `string` | — | Cookie domain (`http-only` only) |
| `cluster` | `boolean` | `true` in prod, `false` in dev | Enable multi-core clustering |
| `workers` | `number` | `os.cpus().length` | Worker count override |
| `tasks` | `TaskConfig \| false` | `false` | Background task runtime |
| `cors` | `boolean \| CorsConfig` | `true` | CORS — pass `origin` explicitly, not auto-read from env |
| `requestTimeout` | `number` | — | Request timeout in ms (408 on exceed) |
| `logging` | `LoggingConfig \| false` | pretty in dev TTY, JSON otherwise | pino logging; every request gets an `X-Request-Id` |
| `cache` | `CacheConfig \| false` | — | `{ backend: 'redis', url }` or `{ backend: 'memory' }` — enables `cache`, `cacheResponse()` and session revocation |
| `globalMiddlewares` | `RequestHandler[]` | `[]` | Applied to every route |
| `dashboard` | `boolean` | `true` in dev | Dev route dashboard at `/` |
| `onWorkerReady` | `(id) => void` | — | Called when a worker boots |
| `onWorkerCrash` | `(id, code) => void` | — | Called before respawn |
| `onError` | `ErrorRequestHandler` | built-in | Override global error handler |

---

## CLI Reference

```bash
# Development
efc start dev         # Hot-reload single process (tsx --watch), .env re-read on every restart

# Production
efc build prod        # Type-check + transpile src/ → dist/src/ (tsup, unbundled)
efc start prod        # Run dist/src/index.js with clustering enabled

# Tests
efc run tests         # Vitest  (--watch, --coverage passthrough)

# Code generation
efc generate route users/[id]       # → src/api/users/[id].ts
efc generate task ProcessPayment    # → src/tasks/ProcessPayment.ts
efc generate middleware authorize   # → src/middlewares/authorize.ts
efc generate migration add_orders   # → src/migrations/<timestamp>_add_orders.ts
efc generate seed demo_users        # → src/seeds/demo_users.ts

# Database
efc db migrate | rollback | status  # Migrations
efc db seed [name]                  # Seeds
efc db studio                       # Read-only browser on 127.0.0.1

# Diagnostics
efc routes            # Print resolved route table (path → file → methods)
efc tasks             # List registered background tasks
efc tasks failed | retry | purge    # Dead-letter queue
efc doctor            # Validate project setup, package.json/tsconfig, .env vars
```

---

## Clustering Architecture

```
              Master Process
         ┌────────────────────┐
         │  fork × N workers  │
         │  respawn on crash   │
         └──┬──────┬──────┬───┘
            │      │      │
       Worker 1  Worker 2  Worker N
       Pre-Flight lifecycle per worker:
         1. Connect database
         2. Configure auth
         3. Scan tasksDir → register tasks
         4. Start BullMQ backend
         5. Scan apiDir → build route map
         6. Mount routes on Express
         7. Listen (OS round-robins connections)
```

CPU-bound tasks fan out further into `worker_threads` — the request loop stays unblocked at every layer.

---

## Error Handling

```ts
import { HttpError } from 'express-file-cluster';

// Throw from any handler — caught and formatted automatically
export const GET = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
};

// Override the global handler
ignite({
  onError: (err, req, res, next) => {
    logger.error(err);
    res.status(err.statusCode ?? 500).json({ error: err.message });
  },
});
```

---

## Environment Variables

`create-efc-app` generates `.env` (gitignored, `JWT_SECRET` pre-filled) and `.env.example` (committed, documented). EFC **does not** auto-load any of these — read them yourself in `efc.config.ts` and pass them to `ignite()`.

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default `3000`) | HTTP listen port |
| `NODE_ENV` | No | `development \| production \| test` — the only env var EFC reads directly |
| `DATABASE_URL` | If using a database | MongoDB or PostgreSQL connection string |
| `JWT_SECRET` | If using auth | JWT signing key — auto-generated by scaffolder |
| `JWT_EXPIRES_IN` | No (default `7d`) | Token lifetime |
| `COOKIE_DOMAIN` | No | Cookie domain for `http-only` auth |
| `REDIS_URL` | If using BullMQ | Redis connection for the task queue |
| `CORS_ORIGINS` | No | Comma-separated allowed origins — e.g. `http://localhost:3000,https://myapp.com` |

## License

MIT © 2026 EFC Contributors
