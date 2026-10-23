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
- Structured logging (pino) with request IDs; opt-in query logging (`logging.queries`: per-operation duration + statement count, slow queries, N+1 warnings)
- Cache (`cache`, `cacheResponse`) on Redis or memory, also used as the JWT session-revocation store
- CLI (`efc` binary) incl. migrations (hand-written or generated from model diffs: `efc db generate`), seeds, `efc db pull`, `efc import-prisma`, a read-only studio and a shadcn-style feature registry (`efc add | list | view | diff | init`)

**Status: v0.9.0 — Beta launch (Phase 2 complete; Phase 3 data layer: M1 inferred types, M2 `defineTable`, M3 relations, M4 schema lifecycle, M6a query logging; `efc add` feature registry). Releases from here are minor bumps (0.10.0, 0.11.0, …).** See `README.md` and `docs/` for full documentation.

---

## Monorepo layout

```
packages/core/src/       ← framework source (express-file-cluster)
packages/create-efc-app/ ← npx create-efc-app scaffolder
packages/mcp/            ← express-file-cluster-mcp (MCP server serving the docs)
docs/                    ← documentation
client/                  ← marketing site (static)
Skills/efc/              ← dense reference cards (/efc skill)
```

---

## Three import paths — nothing else

```ts
import { ignite, gracefulShutdown, compose, HttpError, db, defineModel, defineTable, transaction,
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

- Engine = `config.database` ?? `databaseUrl` scheme; models compile on first use (define at import time is fine); `databasePool: { max, idleTimeoutMs, connectionTimeoutMs }` sizes the per-worker pool (pg Pool / mongoose)
- MongoDB needs `mongoose`; PostgreSQL needs `pg` + `drizzle-orm` (all optional peers)
- Tables (PostgreSQL) / collections + indexes (MongoDB) reconcile automatically on a model's first use (`autoSync`, default true; advisory-locked, one transaction). Sync adds columns, renames `renamedFrom` columns, converts types, drops NOT NULLs the model doesn't ask for (keeps them on required fields), rebuilds enum CHECKs (NOT VALID), creates/drops EFC-named indexes — never drops columns or rows. `efc db sync [--dry-run] [--exit-code]` (exit 2 = drift); `autoSync: false` leaves it to migrations
- `efc db generate [name] [--allow-drop] [--tighten] [--verify]` replays `src/migrations` into a throwaway schema (pg, via search_path) / database (mongo) with `Model.sync()` suppressed, plans each model against it (`RegisteredModel.plan()` → `PlanStep`s: idempotent SQL with `skipIf` guards, `check` row counts, best-effort `down`; FKs last) and writes `src/migrations/<ts>_<name>`; `--verify` fails if replaying all migrations misses anything. `efc db migrate --baseline` records without running. `efc db pull` (pg only, `db/pull.ts`) and `efc import-prisma` (`db/prisma-import.ts`) write defineTable files via `db/codegen.ts`
- Types are inferred from the schema literal (`InferRecord<typeof M>`, `InferCreate<typeof M>`) — don't write interfaces; `defineModel<T>()` still works (v0.4 behaviour, `create()` takes `Partial<T>`)
- Portable extras on both engines: `exists`, `distinct` (scalar fields only, sorted, non-null), `updateOne`/`deleteOne` (first match, one statement, return the record), `upsert(filter, create, update)` (filter not merged into create; 409 on create retried once)
- `defineTable(name, schema, options)` = PostgreSQL-only, Prisma vocabulary (`findMany({ where, orderBy, take, cursor, select })`, `findUnique`, `upsert` = INSERT … ON CONFLICT, `groupBy`, `aggregate`) and SQL types (`integer`, `bigint`→`bigint`, `decimal`→string, `uuid`, `json`, `varchar` via `maxLength`, native arrays, `nativeEnum`, `id: 'serial' | 'bigserial'`, `naming: 'snake_case'`). Throws on MongoDB at first use; defineModel ops on it don't compile. Shares pgTable (pg-table.ts) with defineModel's PostgreSQL adapter. Top-level `ref` = real FK (`onDelete: 'restrict'` default | `'cascade'` | `'setNull'`; type must match the target id — `uuid`/`objectId`, `integer` for serial, `bigint` for bigserial; auto-indexed; sync creates the target first, adds NOT VALID then VALIDATE; violations → 400 on the field / 409 on delete). Top-level array of refs = many-to-many via join table `<table>_<column>` (owner_id, ref_id, position; cascades both ways); records keep the id list; list filters + `set`/`push`; reads one statement, link writes in a transaction; first sync backfills from an old array/jsonb column (kept). `include` (own refs → record | null / m:n → list; back-relations via `options.relations: { x: { hasMany | hasOne: 'Model', foreignKey } }`, hasOne needs unique fk; options select/omit/include + where/orderBy/take/skip on lists; one SQL statement at any depth; writes re-read). Typed includes need `declare module 'express-file-cluster' { interface Tables { User: typeof User } }`. Relation filters in `where`: `some`/`every`/`none` (to-many) and `is`/`isNot` (to-one, `null` ok), EXISTS subqueries, any depth. Nested writes in create/update/upsert (one transaction): refs `connect`/`create`/`connectOrCreate` (+ `disconnect: true`), m:n + `disconnect`/`set`/`push`/`pull`, hasMany `connect`/`create`/`disconnect`/`set`/`delete`/`deleteMany`, hasOne `connect`/`create`/`disconnect`/`delete`; missing connect → 400; not in createMany/updateMany. A model first used inside `transaction()` gets its FKs after commit (avoids a lock wait) defineModel refs stay plain columns. `ignite()` serialises bigints in JSON as strings
- Undeclared fields behave like mongoose on both engines: ignored on writes, treated as absent in filters, ignored in sort/select
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
- `defineCollection` (MongoDB-native) — planned in `prisma-parity-plan.md` (M5)

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
- Scaffolded PostgreSQL apps use `defineTable` by default (prompt "Models:"; `ScaffoldOptions.modelApi: 'defineModel'` keeps the portable API): feature models reference `User`/`Admin`/`Plan`/… by FK (no back-`relations` — each feature stays self-contained), and `src/model/index.ts` registers every model and declares `Tables`. Route code is generated through `orm(opts)` in scaffold.ts — never hand-write `User.findOne(...)` in templates
- `create-efc-app` writes only the **base** (server, `src/api` + health, `src/tasks` + SendEmail stub, database, task backend); features are registry items (`packages/create-efc-app/src/registry.ts` `ITEMS`) picked at creation or added with `efc add`. Items are rendered from scaffold.ts in **registry mode** (`registry: true`: login/password flows always handle User + Admin, routes always enqueue SendEmail, rbac + routeDocs on, no back-relations) by diffing scaffolds with/without the item; `renderVariant` throws unless every item is self-contained. `scripts/bundle-registry.mjs` renders 6 variants (ts/js × mongo/pg-model/pg-table) into core `dist/registry`; `efc add` (core `src/cli/registry.ts`) reads it, tracks file hashes in the app's `efc.json`, and never overwrites a changed file without `--overwrite`. Items can declare `prompts` (env vars asked in the terminal by `efc add` and in `create-efc-app`; e.g. `email-client` SMTP, `auth@google`/`auth@apple` OAuth credentials) and `aliases` (`mailer` → `email-client`). When changing a template, keep it free of cross-feature conditionals in registry mode
- `cache` operations never throw on a Redis outage (misses / no-ops); they DO throw if no cache is configured
- `efc.config.ts` is informational; `src/index.ts` is the actual runtime entrypoint
- `efc build prod` transpiles `src/**` unbundled → `dist/src/**` (entry `dist/src/index.js`); routes/tasks must exist as files in `dist/` because they're discovered by filesystem scan
- New runtime packages imported by core must be `dependencies` or (optional) `peerDependencies` — tsup bundles devDependency-only imports into `dist`, which breaks CJS packages at runtime
- `npm run build` bundles `docs/` + `Skills/efc/` into `dist/docs` of `express-file-cluster` and `express-file-cluster-mcp` (`scripts/bundle-docs.mjs`) — docs changes ship with the next release; scaffolded apps get an `AGENTS.md` pointing at them. `AGENTS.md` at the repo root is the cross-agent version of these rules
- Integration tests that need a database self-skip when it's unreachable; CI provides MongoDB (+ replica set), Redis and PostgreSQL. Locally: Mongo `27017` (+ replset `27018`), Redis `6379`, Postgres via `EFC_TEST_PG_URL`

---

## Skill

Load the `efc` skill for dense reference cards:
```
/efc
```
Modules: `api-surface.md`, `routing-rules.md`, `pre-flight.md`, `tasks-internals.md`, `auth-internals.md`, `what-not-to-invent.md`
