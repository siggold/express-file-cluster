# CLAUDE.md — express-file-cluster (EFC)

This is the ground-truth file for working in this repository. Read it before writing any code.

---

## What this project is

A backend framework called **express-file-cluster** (`express-file-cluster` on npm). It wraps Express with:
- File-based routing (directory tree = route tree)
- Multi-core clustering via Node's `cluster` module
- Background tasks via BullMQ (Redis)
- JWT auth (http-only cookie or Bearer token)
- MongoDB adapter via mongoose
- CLI (`efc` binary)

**Status: v0.3.16 Beta.** See `README.md` and `docs/` for full documentation.

---

## Monorepo layout

```
packages/core/src/       ← framework source (express-file-cluster)
packages/create-efc-app/ ← npx create-efc-app scaffolder
usage/                   ← example app (manual testing)
docs/                    ← documentation (24 files, 6 sections)
```

---

## Three import paths — nothing else

```ts
import { ignite, gracefulShutdown, compose, HttpError, db, defineModel } from 'express-file-cluster'
import { issueToken, revokeToken, signToken, requireAuth } from 'express-file-cluster/auth'
import { defineTask, enqueue } from 'express-file-cluster/tasks'
```

**No other sub-paths exist.** `/db`, `/router`, `/errors`, `/models`, `/config` are all invalid.

---

## Routing — the exact rules

1. File path relative to `apiDir` → strip extension → strip `/index` → `[param]` → `:param`
2. Static routes register before dynamic routes (`:param` segments)
3. `export const middlewares = [...]` applies to all methods in that file (must be an array)
4. HTTP method exports must be uppercase: `GET POST PUT PATCH DELETE HEAD OPTIONS`
5. Unimplemented methods on a route that has ≥1 implemented method → auto 405

```
src/api/health.ts          → /health
src/api/users/index.ts     → /users
src/api/users/[id].ts      → /users/:id
src/api/posts/[s]/c.ts     → /posts/:s/c
```

---

## Tasks — the exact rules

- Task name = file basename without extension (case-sensitive)
- `tasksDir` is scanned **non-recursively** — subdirectories are NOT processed
- `export default defineTask<Payload>(async (payload) => {...})` — default export required
- `enqueue('TaskName', payload)` — rejects if backend not configured, name not found, or Redis doesn't accept the job within `tasks.enqueueTimeout` (default 5000 ms)
- `retries: N` = N re-runs → up to N + 1 attempts
- `{ thread: true }` → runs in `worker_threads` (for CPU-bound work)

---

## Pre-Flight boot order (every worker)

1. Create Express + built-in middleware (CORS, json, cookieParser)
2. Connect database (if `database` + `databaseUrl` set)
3. Configure auth (if `jwtSecret` set)
4. Scan + register tasks (if `tasksDir` set)
5. Start task queue backend (if `tasks` set)
6. Scan routes (`scanDir`)
7. Mount routes (`mountRoutes`)
8. Listen on port

---

## What is NOT implemented (Phase 2+)

- PostgreSQL adapter (only MongoDB/mongoose is live)
- pg-boss task backend
- Wildcard/catch-all routes (`[...params]`)
- Cron/scheduled tasks (option exists, not executed)
- Database migrations, rollback, seed, studio CLI commands
- Plugin system
- WebSockets
- `efc lint`, `efc deploy` commands

Do not suggest or generate code for these features.

---

## Common mistakes to avoid

- `ignite()` does NOT auto-load `efc.config.ts` — you must import and pass it yourself
- `apiDir` is not an `ignite()` option — the api directory is always resolved by convention (`src/api`, `api`, then `dist/api`)
- `db` throws if accessed before Pre-Flight (not safe at module load time)
- `requireAuth` is dual-purpose: bare (`requireAuth`) it just verifies the JWT; called with role names (`requireAuth('admin')`) it returns a middleware that also enforces `payload.role`
- `revokeToken` only clears the cookie — the JWT remains valid until expiry
- `efc.config.ts` is informational; `src/index.ts` is the actual runtime entrypoint
- `efc build prod` transpiles `src/**` unbundled → `dist/src/**` (entry `dist/src/index.js`); routes/tasks must exist as files in `dist/` because they're discovered by filesystem scan

---

## Skill

Load the `efc` skill for dense reference cards:
```
/efc
```
Modules: `api-surface.md`, `routing-rules.md`, `pre-flight.md`, `tasks-internals.md`, `auth-internals.md`, `what-not-to-invent.md`
