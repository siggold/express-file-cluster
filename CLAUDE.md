# CLAUDE.md — express-file-cluster (EFC)

This is the ground-truth file for working in this repository. Read it before writing any code.

---

## What this project is

A backend framework called **express-file-cluster** (`express-file-cluster` on npm). It wraps Express with:
- File-based routing (directory tree = route tree), incl. optional and catch-all segments
- Request validation via `export const schema` (any Standard Schema validator)
- Multi-core clustering via Node's `cluster` module, with graceful shutdown
- Background tasks via BullMQ (Redis) or pg-boss (PostgreSQL), with cron and dead-letter tooling
- JWT auth (http-only cookie or Bearer token)
- `defineModel` on MongoDB (mongoose) and PostgreSQL (Drizzle) — one API
- Structured logging (pino) with request IDs
- Cache (`cache`, `cacheResponse`) on Redis or memory, also used as the JWT session-revocation store
- CLI (`efc` binary) incl. migrations, seeds and a read-only studio

**Status: v0.4.0 Beta (Phase 2 complete).** See `README.md` and `docs/` for full documentation.

---

## Monorepo layout

```
packages/core/src/       ← framework source (express-file-cluster)
packages/create-efc-app/ ← npx create-efc-app scaffolder
docs/                    ← documentation
client/                  ← marketing site (static)
Skills/efc/              ← dense reference cards (/efc skill)
```

---

## Three import paths — nothing else

```ts
import { ignite, gracefulShutdown, compose, HttpError, db, defineModel, transaction,
         ModelValidationError, logger, getLogger, cache, cacheResponse } from 'express-file-cluster'
import { issueToken, revokeToken, revokeSession, revokeAllSessions, signToken, requireAuth,
         getCurrentUser } from 'express-file-cluster/auth'
import { defineTask, enqueue } from 'express-file-cluster/tasks'
```

**No other sub-paths exist.** `/db`, `/router`, `/errors`, `/models`, `/config` are all invalid.

---

## Routing — the exact rules

1. File path relative to `src/api` → strip extension → strip `/index` → per segment: `[id]` → `:id`, `[[id]]` → `:id?`, `[...slug]` → `:slug*` (≥1, `string[]`), `[[...slug]]` → `:slug*?` (≥0)
2. Routes sort by per-segment specificity: static < `[id]` < `[[id]]` < `[...slug]` < `[[...slug]]`
3. A catch-all must be the last segment (startup error otherwise)
4. `export const middlewares = [...]` applies to all methods in that file (must be an array)
5. `export const schema = { params?, query?, body? }` (or keyed by method) validates after middlewares → 400 with `issues`; parsed output replaces the input
6. HTTP method exports must be uppercase: `GET POST PUT PATCH DELETE HEAD OPTIONS`
7. Unimplemented methods on a route that has ≥1 implemented method → auto 405

```
src/api/health.ts            → /health
src/api/users/index.ts       → /users
src/api/users/[id].ts        → /users/:id
src/api/users/[[id]].ts      → /users and /users/:id
src/api/docs/[...slug].ts    → /docs/a/b  (req.params.slug = ['a', 'b'])
```

---

## Tasks — the exact rules

- Task name = file basename without extension (case-sensitive)
- `src/tasks` is scanned **non-recursively** — subdirectories are NOT processed
- `export default defineTask<Payload>(async (payload) => {...})` — default export required
- `enqueue('TaskName', payload)` — rejects if backend not configured, name not found, or the backend doesn't accept the job within `tasks.enqueueTimeout` (default 5000 ms)
- `retries: N` = N re-runs → up to N + 1 attempts (both backends)
- `{ thread: true }` → runs in `worker_threads` (for CPU-bound work)
- `{ schedule: '<cron>', timezone? }` → recurring runs with payload `{}`; schedules reconcile on boot
- `tasks: { backend: 'bullmq' | 'pg-boss', queue?: 'efc' }` — pg-boss uses `databaseUrl`
- Dead letters: `efc tasks failed | retry | purge`

---

## Database — the exact rules

- Engine = `config.database` ?? `databaseUrl` scheme; models compile on first use (define at import time is fine)
- MongoDB needs `mongoose`; PostgreSQL needs `pg` + `drizzle-orm` (all optional peers)
- PostgreSQL tables are created only by `Model.sync()` — run from a migration (`efc db migrate`); scaffolded apps ship `src/migrations/00000000000000_init`
- `update()` / `updateMany()` validate changed fields; failures throw `ModelValidationError` (400), duplicate unique → `HttpError` 409
- Shared filter subset: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or`, dotted paths, array contains; updates: `$set $unset $inc $push $pull`
- `aggregate()` and TTL indexes are MongoDB-only; MongoDB `transaction()` needs a replica set
- `db` = mongoose `Connection` (MongoDB) or pg `Pool` (PostgreSQL)

---

## Pre-Flight boot order (every worker)

0. Configure logging (before the primary/worker split)
1. Create Express + request context, request IDs/logging, optional `requestTimeout`, CORS, json, cookieParser
2. Connect database + set the model engine (if `database`/`databaseUrl`), then the cache (if `cache`)
3. Configure auth (if `jwtSecret` set)
4. Scan + register tasks (`src/tasks`)
5. Start task queue backend (if `tasks` set) — cron sync runs in the background
6. Scan routes (`scanDir`)
7. Mount routes (`mountRoutes`)
8. Listen on port

---

## What is NOT implemented (Phase 3+)

- Plugin system
- WebSockets
- OpenAPI generation, OpenTelemetry
- `efc lint`, `efc deploy` commands
- Schema-diff migration generation (`efc db generate`) — migrations are hand-written; `sync()` only adds

Do not suggest or generate code for these features.

---

## Common mistakes to avoid

- `ignite()` does NOT auto-load `efc.config.ts` — you must import and pass it yourself
- `apiDir`/`tasksDir` are not `ignite()` options — `src/api` and `src/tasks` are resolved by convention
- `db` throws if accessed before Pre-Flight (not safe at module load time)
- `requireAuth` is dual-purpose: bare (`requireAuth`) it just verifies the JWT; called with role names (`requireAuth('admin')`) it returns a middleware that also enforces `payload.role`
- `revokeToken` only clears the cookie — the JWT remains valid until expiry. `revokeSession(req, res?)` / `revokeAllSessions(userId)` actually revoke, but need `cache` configured. If the cache is unreachable, `requireAuth` answers 503 by default (`cache.onRevocationCheckError: 'allow'` passes requests instead); the revoke calls throw
- The `memory` cache backend lives in the cluster primary and workers use it over IPC (shared per machine, lost on restart, not shared across instances) — use `redis` for multiple instances
- Scaffolded apps set `cache` (Redis if `REDIS_URL`, else memory); their logout uses `revokeSession` and password reset calls `revokeAllSessions`
- `cache` operations never throw on a Redis outage (misses / no-ops); they DO throw if no cache is configured
- `efc.config.ts` is informational; `src/index.ts` is the actual runtime entrypoint
- `efc build prod` transpiles `src/**` unbundled → `dist/src/**` (entry `dist/src/index.js`); routes/tasks must exist as files in `dist/` because they're discovered by filesystem scan
- New runtime packages imported by core must be `dependencies` or (optional) `peerDependencies` — tsup bundles devDependency-only imports into `dist`, which breaks CJS packages at runtime
- Integration tests that need a database self-skip when it's unreachable; CI provides MongoDB (+ replica set), Redis and PostgreSQL. Locally: Mongo `27017` (+ replset `27018`), Redis `6379`, Postgres via `EFC_TEST_PG_URL`

---

## Skill

Load the `efc` skill for dense reference cards:
```
/efc
```
Modules: `api-surface.md`, `routing-rules.md`, `pre-flight.md`, `tasks-internals.md`, `auth-internals.md`, `what-not-to-invent.md`
