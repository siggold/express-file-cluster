# Project Structure

A scaffolded EFC project looks like this:

```
my-api/
├── src/
│   ├── api/                       # HTTP routes — every file here is a route
│   │   ├── health.ts              # GET /health
│   │   ├── auth/
│   │   │   ├── login.ts           # POST /auth/login
│   │   │   ├── logout.ts          # POST /auth/logout
│   │   │   └── register.ts        # POST /auth/register (if userPortal)
│   │   └── users/
│   │       ├── index.ts           # GET /users  •  POST /users
│   │       └── [id].ts            # GET /users/:id  •  DELETE /users/:id
│   ├── tasks/                     # Background jobs (scanned non-recursively)
│   │   └── SendEmail.ts           # task name: "SendEmail"
│   ├── model/                     # Engine-agnostic data models
│   │   ├── User.ts
│   │   └── Role.ts                # generated if the RBAC option is enabled
│   ├── migrations/                # efc db migrate — run in filename order
│   │   └── 00000000000000_init.ts # syncs every generated model
│   ├── seeds/                     # efc db seed (create with efc generate seed)
│   └── index.ts                   # Framework entry point
├── efc.config.ts                  # Structural configuration
├── .env                           # Real secrets — gitignored
├── .env.example                   # Documented template — safe to commit
├── .gitignore
├── package.json
└── tsconfig.json
```

If you enable the **User portal**, **Admin portal**, **RBAC**, or **Mailer** options during scaffolding, `src/model/`, `src/api/`, and `src/tasks/` fill out considerably — see [Generated Portals](../guides/generated-portals.md) for the full list of models and routes, [RBAC](../guides/rbac.md) for the `requireAuth('role')` shorthand, and [Mailer](../guides/mailer.md) for the SMTP setup.

---

## `src/api/` — Route modules

`src/api/` is a fixed convention, not a configurable option — EFC resolves it automatically (checking `src/api`, then `api`, then `dist/api` for compiled output). Every `.ts` (or `.js`) file inside it becomes a route. The URL path is derived from the file path relative to `src/api/`:

| File | URL |
|---|---|
| `api/health.ts` | `/health` |
| `api/users/index.ts` | `/users` |
| `api/users/[id].ts` | `/users/:id` |
| `api/posts/[slug]/comments.ts` | `/posts/:slug/comments` |

Files named `index.ts` inside a directory map to the directory's URL (no `/index` suffix).
`[bracket]` segments become Express `:param` segments.

See [File-Based Routing](../core-concepts/file-based-routing.md) for the complete rule set.

---

## `src/tasks/` — Background task modules

`src/tasks/` is likewise a fixed convention. It is scanned **non-recursively** — subdirectories are not processed. Every file directly inside it registers a named background task; the task name is the file's basename without extension:

| File | Task name |
|---|---|
| `tasks/SendEmail.ts` | `"SendEmail"` |
| `tasks/ResizeImage.ts` | `"ResizeImage"` |

Tasks must export a default `TaskDefinition` created with `defineTask()`.

See [Background Tasks](../core-concepts/background-tasks.md).

---

## `src/model/` — Data models

Engine-agnostic model definitions using `defineModel()` — they compile to a mongoose model on MongoDB or a Drizzle table on PostgreSQL, with the same API on both.

See [Database Guide](../guides/database.md).

---

## `src/migrations/` and `src/seeds/`

Migration files export `up()` / `down()` and run in filename order with `efc db migrate` / `efc db rollback`; seeds export a default function and run with `efc db seed`. Both are loaded from `src/` under `tsx` in development and from `dist/src/` in production. See [Migrations & Seeds](../guides/migrations.md).

---

## `src/index.ts` — Entry point

The single call that boots the framework:

```ts
import { ignite, gracefulShutdown } from 'express-file-cluster';

ignite({
  // cluster defaults to NODE_ENV === 'production' — don't hardcode true here, or
  // dev mode clusters too (an explicit boolean always wins over that default)
  workers: 2,
  tasks: { backend: 'bullmq' },
})
  .then(gracefulShutdown)
  .catch(console.error);
```

`ignite()` does **not** read `PORT`, `DATABASE_URL`, `JWT_SECRET`, or `CORS_ORIGINS` from `process.env` automatically — pass them explicitly (see `efc.config.ts` below; `NODE_ENV` is the sole exception). `src/api/` and `src/tasks/` are resolved by convention, not passed as options — there is no `apiDir`/`tasksDir` config.

See [`ignite()` API reference](../api-reference/ignite.md).

---

## `efc.config.ts` — where every runtime value is wired

`ignite()` never reads `process.env` itself for app config (the one exception is `NODE_ENV`, a Node/Express-wide runtime-mode signal — see [Environment Variables](../guides/environment-variables.md#precedence)). The scaffolder generates a typed config file that reads `.env` explicitly and builds the object `ignite()` receives — both structural choices (auth strategy, task backend) and runtime values (port, database URL, JWT secret, CORS origins, ...) live here:

```ts
import type { EFCConfig } from 'express-file-cluster';

// The framework never reads process.env itself — every runtime value it needs is read
// here, explicitly, and passed in. Edit .env to change values; edit this file to change
// which env vars are wired up or add new ones.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

const config: EFCConfig = {
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  cookieDomain: process.env.COOKIE_DOMAIN,
  cors: corsOrigins ? { origin: corsOrigins } : true,
  authStrategy: 'http-only',
  tasks: { backend: 'bullmq', concurrency: 5, redisUrl: process.env.REDIS_URL },
  globalMiddlewares: [],
};

export default config;
```

`ignite()` itself does **not** auto-load `efc.config.ts` — `src/index.ts` is the actual runtime entrypoint. The generated `src/index.ts` imports `efc.config.ts` and spreads its fields into `ignite()`, so this file is the single source of truth for what's actually applied:

```ts
import { ignite, gracefulShutdown } from 'express-file-cluster';
import config from '../efc.config.js';

ignite({ ...config }).then(gracefulShutdown).catch(console.error);
```

The scaffolded `tsconfig.json` includes `efc.config.ts` alongside `src/**/*` so this import typechecks without a `rootDir` violation.

---

## `.env` and `.env.example`

`.env` is gitignored and holds real secrets. `.env.example` is committed and documents every required variable with placeholder values.

See [Environment Variables](../guides/environment-variables.md) for the full variable reference.
