# CLAUDE.md — express-file-cluster (EFC)

This is the ground-truth file for working in this repository. Read it before writing any code.

---

## Identity & Git Commits

- Always use the following author and committer identity for all git commits:
  - Name: `Prashant Adhikari`
  - Email: `student@prashantadhikari7.com.np`
- **NEVER** include `Co-Authored-By: Claude ...` (or any other AI co-author tag) in commit messages.
- Do not mention Claude in commit messages.

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
- CLI (`efc` binary) incl. migrations (hand-written or generated from model diffs: `efc db generate`), seeds, `efc db pull`, `efc import-prisma`, a studio (read-only; `--write` edits through the models, page-token + origin checked) and a shadcn-style feature registry (`efc add | list | view | diff | init`)

**Status: v0.12.1 — Beta (Phase 2 complete; Phase 3 data layer: M1 inferred types, M2 `defineTable`, M3 relations, M4 schema lifecycle, M5 `defineCollection`, M6 tooling/metrics/prepared statements/benchmarks complete; custom auth entities; `efc add` feature registry). Fixes ship as patch releases (0.9.5, 0.9.6, …); features as minor bumps.** See `README.md` and `docs/` for full documentation.

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

## Four import paths — nothing else

```ts
import { ignite, gracefulShutdown, compose, HttpError, db, defineModel, defineTable, defineCollection, transaction,
         ModelValidationError, logger, getLogger, cache, cacheResponse, rateLimit } from 'express-file-cluster'
import { issueToken, revokeToken, revokeSession, revokeAllSessions, signToken, requireAuth,
         getCurrentUser, hashPassword, verifyPassword, passwordNeedsRehash } from 'express-file-cluster/auth'
import { defineTask, enqueue } from 'express-file-cluster/tasks'
import { createTestApp } from 'express-file-cluster/testing'
```

**No other sub-paths exist.** `/db`, `/router`, `/errors`, `/models`, `/config` are all invalid.

---

`express-file-cluster/testing` exports `createTestApp({ apiDir, ... })` and `TestAppOptions`: a real Express/router app sharing production HTTP middleware/error handling, without listen/cluster/services/signals or cwd changes. `apiDir` is a helper option only. Auth/logging are process-wide; the helper disables logging and does not reset model/cache/task state.

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
- `efc db generate [name] [--allow-drop] [--tighten] [--verify]` replays `src/migrations` into a throwaway schema (pg, via search_path) / database (mongo) with `Model.sync()` suppressed, plans each model against it (`RegisteredModel.plan()` → `PlanStep`s: idempotent SQL with `skipIf` guards, `check` row counts, best-effort `down`; FKs last) and writes `src/migrations/<ts>_<name>`; `--verify` fails if replaying all migrations misses anything. `efc db migrate --baseline` records without running. `efc db pull` (pg: `db/pull.ts` → defineTable; mongo: `db/pull-mongo.ts` samples documents with `promoteValues: false` → defineCollection, refs from names or from which collection holds the sampled ids) and `efc import-prisma` (`db/prisma-import.ts`) write model files via `db/codegen.ts`
- Types are inferred from the schema literal (`InferRecord<typeof M>`, `InferCreate<typeof M>`) — don't write interfaces; `defineModel<T>()` still works (v0.4 behaviour, `create()` takes `Partial<T>`)
- Portable extras on both engines: `exists`, `distinct` (scalar fields only, sorted, non-null), `updateOne`/`deleteOne` (first match, one statement, return the record), `upsert(filter, create, update)` (filter not merged into create; 409 on create retried once)
- `defineTable(name, schema, options)` = PostgreSQL-only, Prisma vocabulary (`findMany({ where, orderBy, take, cursor, select })`, `findUnique`, `upsert` = INSERT … ON CONFLICT, `groupBy`, `aggregate`) and SQL types (`integer`, `bigint`→`bigint`, `decimal`→string, `uuid`, `json`, `varchar` via `maxLength`, native arrays, `nativeEnum`, `id: 'serial' | 'bigserial'`, `naming: 'snake_case'`). Throws on MongoDB at first use; defineModel ops on it don't compile. Shares pgTable (pg-table.ts) with defineModel's PostgreSQL adapter. Top-level `ref` = real FK (`onDelete: 'restrict'` default | `'cascade'` | `'setNull'`; type must match the target id — `uuid`/`objectId`, `integer` for serial, `bigint` for bigserial; auto-indexed; sync creates the target first, adds NOT VALID then VALIDATE; violations → 400 on the field / 409 on delete). Top-level array of refs = many-to-many via join table `<table>_<column>` (owner_id, ref_id, position; cascades both ways); records keep the id list; list filters + `set`/`push`; reads one statement, link writes in a transaction; first sync backfills from an old array/jsonb column (kept). `include` (own refs → record | null / m:n → list; back-relations via `options.relations: { x: { hasMany | hasOne: 'Model', foreignKey } }`, hasOne needs unique fk; options select/omit/include + where/orderBy/take/skip on lists; one SQL statement at any depth; writes re-read). Typed includes need `declare module 'express-file-cluster' { interface Tables { User: typeof User } }`. Relation filters in `where`: `some`/`every`/`none` (to-many) and `is`/`isNot` (to-one, `null` ok), EXISTS subqueries, any depth. Nested writes in create/update/upsert (one transaction): refs `connect`/`create`/`connectOrCreate` (+ `disconnect: true`), m:n + `disconnect`/`set`/`push`/`pull`, hasMany `connect`/`create`/`disconnect`/`set`/`delete`/`deleteMany`, hasOne `connect`/`create`/`disconnect`/`delete`; missing connect → 400; not in createMany/updateMany. A model first used inside `transaction()` gets its FKs after commit (avoids a lock wait) defineModel refs stay plain columns. `ignite()` serialises bigints in JSON as strings
- `defineCollection(name, schema, options)` = MongoDB-only, mongoose vocabulary (`find(filter, { projection, sort, skip, limit, populate, collation })`, `findOneAndUpdate` (returns *before* unless `returnDocument: 'after'`), `updateOne/updateMany/replaceOne` → `{ matchedCount, modifiedCount, upsertedCount, upsertedId }`, `deleteOne/deleteMany` → `{ deletedCount }`, `bulkWrite`, `aggregate<T>`, `watch` (replica set), `countDocuments`, `estimatedDocumentCount`) and BSON types (`decimal128`→string, `long`→bigint, `geoPoint`, `binary`→Buffer; `index: '2dsphere' | 'text' | 'hashed'`, partial indexes). Throws on PostgreSQL at first use; SQL-only types refused at definition. Reuses defineModel's MongoDB adapter (`collection-model.ts` over `mongo-model.ts`) for compile, validation, sync, plan
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
- `efc lint`, `efc deploy` commands

Do not suggest or generate code for these features.

---

## Common mistakes to avoid

- `ignite()` does NOT auto-load `efc.config.ts` — you must import and pass it yourself
- `apiDir`/`tasksDir` are not `ignite()` options — `src/api` and `src/tasks` are resolved by convention
- `db` throws if accessed before Pre-Flight (not safe at module load time)
- `requireAuth` is dual-purpose: bare (`requireAuth`) it just verifies the JWT; called with role names (`requireAuth('admin')`) it returns a middleware that also enforces `payload.role`
- `revokeToken` only clears the cookie — the JWT remains valid until expiry. `revokeSession(req, res?)` / `revokeAllSessions(userId)` actually revoke, but need `cache` configured. If the cache is unreachable, `requireAuth` answers 503 by default (`cache.onRevocationCheckError: 'allow'` passes requests instead); the revoke calls throw
- The `memory` cache backend lives in the cluster primary and workers use it over IPC (shared per machine, lost on restart, not shared across instances) — use `redis` for multiple instances
- `rateLimit` counts with `cache.incr` (needs `cache`; atomic: Redis Lua / the primary's memory store), clock-aligned fixed windows, default key `req.ip` — behind a proxy without `trustProxy` every client shares one bucket, so generated login/forgot-password key on the email too. `cache.incr` resolves `undefined` when Redis is down; `rateLimit` then allows (default) or 503s
- Scaffolded apps set `cache` (Redis if `REDIS_URL`, else memory); their logout uses `revokeSession`. Password reset and change call `revokeAllSessions`; change verifies the old password and clears stored refresh credentials. Generated 2FA is app code with TOTP/email OTP (`TWO_FACTOR_METHOD=totp|email|both`, one method per account); init adds SMTP setup for email choices. Enrollment/disable require the password; login verifies the factor before issuing tokens, atomically consumes codes, and shares rate limits with `/auth/2fa/verify`. Keep independent `TWO_FACTOR_KEY` across instances (AES-256-GCM TOTP secrets, keyed email digests); strip all secret/challenge fields from records. OAuth rejects 2FA-enabled accounts; refresh rotation compare-and-sets the old token + enabled state. No recovery codes. Device-session list/revoke remain authenticated 501 extension points.
- `compose()` must forward `next(err)` and Express route/router skip signals without running subsequent composed handlers. Catch-all mapping must split raw captures before decoding each segment exactly once.
- Scaffolded PostgreSQL apps use `defineTable` and MongoDB apps `defineCollection` by default (prompt "Models:"; `ScaffoldOptions.modelApi: 'defineModel'` keeps the portable API; `usesTables` / `usesCollections` in scaffold.ts): feature models reference `User`/`Admin`/`Plan`/… by FK (no back-`relations` — each feature stays self-contained), and `src/model/index.ts` registers every model and declares `Tables`. Route code is generated through `orm(opts)` in scaffold.ts — never hand-write `User.findOne(...)` in templates
- Generated routes must check that request values are strings (`typeof x !== 'string'` → 400) before they reach a filter, and strip `password`, `refreshToken`, `resetToken`, `verifyToken` (+ expiries) from records they return (e2e `validates request value types…` guards it)
- `create-efc-app` writes only the **base** (server, `src/api` + health, `src/tasks` + SendEmail stub, database, task backend); features are registry items (`packages/create-efc-app/src/registry.ts` `ITEMS`) picked at creation or added with `efc add`. Items are rendered from scaffold.ts in **registry mode** (`registry: true`: login/password flows always handle User + Admin, routes always enqueue SendEmail, rbac + routeDocs on, no back-relations) by diffing scaffolds with/without the item; `renderVariant` throws unless every item is self-contained. `scripts/bundle-registry.mjs` renders 8 variants (ts/js × mongo/mongo-collection/pg-model/pg-table; existing Mongo apps' `efc.json` says `defineModel` → the `mongo` variant) into core `dist/registry`; `efc add` (core `src/cli/registry.ts`) reads it, tracks file hashes in the app's `efc.json`, and never overwrites a changed file without `--overwrite`. Items can declare `prompts` (env vars asked in the terminal by `efc add` and in `create-efc-app`; e.g. `email-client` SMTP, `auth@google`/`auth@apple` OAuth credentials) and `aliases` (`mailer` → `email-client`). Custom authenticatable entities beyond User/Admin are scaffolded via `efc add auth --entity <name>`, `efc add auth:<name>`, or `efc add auth new <name>` (e.g. `efc add auth:merchant`), generating a model + namespaced auth routes (`src/api/auth/<slug>/register|login|logout|me`). When changing a template, keep it free of cross-feature conditionals in registry mode
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

- Core builds keep tsup `shims: true`: shared modules use `import.meta.url` for worker/CLI paths; leaving it verbatim in CJS chunks makes public `require()` entrypoints fail to parse.

- PostgreSQL model statements are automatically named through a private Drizzle driver Pool/client proxy (`db/prepared-statements.ts`); native `db` is unchanged. `databasePool.preparedStatements` defaults true (100 names per connection), accepts `{ max }` (nonnegative safe integer), or false/zero to disable for incompatible poolers. Preserve values, types/rowMode, caller names and transaction behavior. EFC schema sync/drop invalidates reusable SQL shapes; name budgets are lifetime-bounded, excess shapes run unnamed, no eviction/DEALLOCATE. Reconnect after external DDL.
- M6 nightly benchmark comparison is a 10% relative regression gate (EFC / fastest contender). Missing operations/contenders and invalid timings must fail; never silently skip missing baseline coverage.

- `logging.queries.metrics` opt-in collects bounded per-process model/op metrics (1000 entries by default, `{ maxEntries: 0 }` disables). `getQueryMetrics` returns detached snapshots; `resetQueryMetrics` clears the window. No SQL, values or error strings. Nested statement counts remain inclusive; overflow observations count as `dropped`. Since 0.12.0 OpenTelemetry instrumentation is described in the tracing guide.

Auth race guards: generated login CAS includes the verified password hash; login/refresh capture `efc_auth_at` before DB reads, and revocation rejects authentication at/before the cutoff. Generated logout is authenticated and invalidates DB refresh credentials even in bearer mode. The CommonJS testing entry delegates to ESM to share state with imported ESM routes.

Reset links are consumed by a DB compare-and-set with expiry rechecked after hashing; success clears refresh credentials and pending challenges, preserving active 2FA. ESM/CJS auth/context/cache share internal process state. Custom entity logout must propagate revocation failures.

Since 0.11.0, OpenAPI and WS are included. OpenAPI is opt-in, uses loaded route metadata + Standard JSON Schema/explicit adapters, and supports offline directory generation. File `WS` exports reuse the HTTP middleware/auth/param pipeline; origin checks, payload caps, heartbeat and close draining are built in. Connection sets are worker-local; auth is handshake-only. Read the new API references and guides. No additional import subpaths.

0.11.0 network review fixes: OpenAPI document URL collision checks use actual GET/HEAD matchers, including hidden operations. Optional URL variants keep greedy parameter bindings; ambiguous templates across routes fail. Query object combinators retain fields and requiredness; full query constraints remain under `x-efc-query-schema`, and object fields use deepObject. Non-object parameter shapes require explicit operation parameters. WS drains include pending handshakes; active-HTTP pipelined upgrades close safely. Payload/timer options cannot exceed signed int32.

0.11.0 OpenAPI serialization: array query parameter names use bracket syntax (`tags[]`, form/explode) so single values remain arrays. External field refs are preserved without network resolution; root object extraction still needs local structure or explicit parameters. Body requiredness follows converted-schema acceptance of Express’s empty missing-body object, without executing validators; unknown refs remain conservative and explicit requestBody metadata takes precedence.

Since 0.12.0: `tracing?: boolean | TracingOptions` instruments HTTP and native task backends; app SDK/context manager/exporter remain app-owned. Native peers now require BullMQ ≥5.79.1 or pg-boss ≥12.38.0. W3C trace fields only; payloads stay unchanged. HTTP spans end once on finish/abort/101 and use templates instead of raw URLs. Task auth scope is fresh; threads preserve nested enqueue context without copying the SDK. App shutdown is awaited after serving-process HTTP/task drain, within the deadline; rejection exits 1. No new subpath.

Since 0.12.0 tracing interoperability: task registry and enqueue implementation share process state across ESM/CJS package formats, matching auth/context/cache. The thread enqueue bridge remains isolate-local.

Since 0.12.0 production hardening: all file/global/error middleware is promise-aware; explicit HEAD precedes GET. Thread isolates dispose handles after completion, reject premature exits, and isolate internal commands from progress messages with a per-worker token. Shutdown waits for every task backend before closing shared cache and telemetry, aggregating failures and exiting nonzero. pg-boss escapes reserved payload keys; null acknowledgments reject; queue readiness cannot submit after timeout, but in-flight command outcomes remain ambiguous, so tasks must be idempotent. Response-cache user/method identities cannot collide, Vary/cache-control/cookie rules apply, and completed serialized JSON bytes are replayed without applying Express replacers twice. cache.wrap failures/reconfiguration do not poison keys. Domain cookies clear correctly; auth stops after timeout. Session cutoffs persist, memory revocations cannot be evicted, and protected-capacity exhaustion rejects writes. Cache IPC closes pending requests and handles disconnected sends.
