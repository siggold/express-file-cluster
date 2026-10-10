# EFC — Implementation Checklist

> Status as of 2026-10-10. **Phase 1 (Core MVP) and Phase 2 (Beta) complete** — see each section; Phase 3 is next.

---

## Phase 0 — Design & Planning

- [x] Define core API (`ignite()` options, route + task conventions)
- [x] Write `plan.md`
- [ ] Decide package name & npm scope
- [ ] Set up contribution guidelines & repo standards
- [x] Choose test runner (Vitest) + CI setup

---

## Phase 1 — Core MVP

### 1.1 Project Bootstrap

- [x] Initialise monorepo (`packages/core`, `packages/create-efc-app`)
- [x] TypeScript build (`tsup`) + dual CJS/ESM output
- [x] ESLint + Prettier config
- [x] GitHub Actions: lint + typecheck + build + test on every PR (`.github/workflows/ci.yml`)
- [ ] `packages/adapters` package scaffold — moved to Phase 2 (only needed once a second adapter exists)

### 1.2 File-Based Router

- [x] Recursive `apiDir` scan → route map (`router/scan.ts`)
- [x] Static / index / dynamic segment resolution (`[param]` → `:param`)
- [x] Method dispatching (uppercase export → HTTP verb)
- [x] Auto `405` for unimplemented verbs
- [x] Per-route `middlewares[]` injection
- [ ] Catch-all / wildcard routes (`[...params].ts`) — Phase 2 (listed below)

### 1.3 Clustering

- [x] Master forks `os.cpus().length` workers (`cluster/index.ts`)
- [x] Pre-Flight lifecycle wired in `ignite()` (DB → auth → routes → listen)
- [x] Self-healing respawn on worker crash
- [x] `onWorkerReady` / `onWorkerCrash` hooks
- [x] `cluster: false` single-process bypass

### 1.4 Database Adapters

- [x] `db` proxy export — thread-local client slot (`db/index.ts`)
- [x] **MongoDB adapter** — connect mongoose in Pre-Flight, expose `db` as `mongoose.Connection`
- [x] **`defineModel`** — unified CRUD surface compiling to mongoose schema
- [x] Normalised record shape (`id` mapped from `_id`)
- [x] `enum` field constraint — verified via `validateSync()` (2026-07-19)
- [x] `objectId` + `ref` + `.populate()` support
- [x] Typed arrays (`of`) incl. `objectId` arrays with `ref`
- [x] Nested array-of-subdocument schemas (`field: [{...}]`) — verified sub-field `required` validation fires correctly
- [x] **Schema-level "operator code" defaults** — `'$now'`, `'$uuid'`, `'$objectId'`, `'$timestamp'`, `'$shortId'`, `'$currentUser[.key]'` (see Review Follow-ups below)
- [ ] PostgreSQL adapter (`pg` / Drizzle) — Phase 2 (listed below)

### 1.5 Auth + Errors

- [x] `http-only` strategy — `issueToken`, `revokeToken`, `requireAuth` (`auth/index.ts`)
- [x] `localStorage` strategy — `signToken` + Bearer verify
- [x] `HttpError` class (`errors.ts`)
- [x] Global error interceptor in `ignite()`
- [x] `compose()` handler-level middleware helper

### 1.6 Background Tasks

- [x] `defineTask` API — I/O-bound and CPU-bound (`tasks/index.ts`)
- [x] `enqueue` stub — throws until a backend is wired
- [x] `taskRegistry` map
- [x] **`tasksDir` scanner** — auto-import task files on startup, register into `taskRegistry`
- [x] **BullMQ backend** — wire `setEnqueueImpl` to a real BullMQ queue + worker
- [ ] pg-boss backend — Phase 2 (listed below)
- [x] `thread: true` → `worker_threads` execution for CPU-bound tasks
- [ ] Cron/scheduled tasks (`schedule` option on `defineTask`) — Phase 2 (listed below)

### 1.7 CLI (`efc`)

- [x] `efc start dev` — spawns `node --watch` with `tsx`
- [x] `efc start prod` — runs `dist/index.js`
- [x] `efc build prod` — type-check + `tsup`
- [x] `efc run tests` — delegates to Vitest
- [x] `efc generate route <path>`
- [x] `efc generate task <name>`
- [x] `efc generate middleware <name>`
- [x] `efc routes` — print resolved route table
- [x] `efc tasks` — list registered tasks
- [x] `efc doctor` — validate config, env vars, project setup
- [ ] `efc db migrate / rollback / seed / studio` — Phase 2 (listed below)
- [x] `efc --version` reads from `package.json` at runtime (was hardcoded `0.1.0`; fixed 2026-10-10)

### 1.8 Scaffolder (`create-efc-app`)

- [x] Interactive prompts (language, DB, auth, cluster, tasks, queue backend)
- [x] Generates `package.json`, `tsconfig.json`, `efc.config.ts`, entry point
- [x] Generates `.env` (random `JWT_SECRET`) + `.env.example` + `.gitignore`
- [x] Generates example route (`src/api/health.ts`)
- [x] Generates default admin/user panels and auth routes
- [x] Generates example task (`src/tasks/SendEmail.ts`) when tasks enabled
- [x] Runs `npm install` after scaffold
- [x] End-to-end test of the full scaffold flow — `create-efc-app/src/__tests__/e2e.test.ts`: scaffold (interactive defaults) → `npm install` → `efc build prod` → clustered boot → health / register / login / `/me` → graceful SIGTERM. CI `e2e` job on Node 22 + 24 (2026-10-10)

### 1.9 Testing

- [x] Unit tests: route scanner (`scan.test.ts`)
- [x] Unit tests: route mount (`mount.test.ts`)
- [x] Unit tests: task scanner (`scanner.test.ts`)
- [x] Unit tests: auth (`auth/index.test.ts`)
- [x] Unit tests: `ignite()` (`ignite.test.ts`)
- [x] Unit tests: `defineModel` schema compilation — enum / nested-array / defaults / all `$`-operator codes / `ModelOptions.timestamps` (`db/model.smoke.test.ts`, added + expanded 2026-07-19) — schema-only, no live DB needed
- [x] Integration: `defineModel` against a real local MongoDB — sequence/`$increment`, `$currentUser`, `update()` (`db/model.integration.test.ts`, added 2026-07-19) — self-skips when Mongo isn't reachable; 7 files / 45 tests total as of this update
- [x] Integration: static / index / dynamic route resolution, static-before-dynamic precedence, file-level middlewares, default `basePath` (`integration/routes.test.ts`, 2026-10-10)
- [x] Integration: clustering respawn + graceful shutdown, both process-group and primary-only SIGTERM (`integration/cluster.test.ts`, 2026-10-10)
- [x] Integration: task enqueue → process → retry → dead-letter, plus fail-fast when Redis is down (`integration/tasks.test.ts`, 2026-10-10)
- [x] Integration: auth middleware through `ignite()` — issue + verify + revoke, role enforcement, wrong-secret rejection (`integration/auth.test.ts`, 2026-10-10)

---

## Phase 1 Exit Criteria — met 2026-10-10

- [x] `npx create-efc-app` works end-to-end without manual steps (CI `e2e` job)
- [x] `efc start dev` serves routes (binary wired, tsx delegation works)
- [x] `enqueue('SendEmail', …)` runs off the request path with retries
- [x] Clustering spawns correct worker count and respawns on crash
- [x] `efc run tests` is green in CI

---

## Phase 1 Review Follow-ups (found 2026-07-19)

Verified with real repros against the built package (not just reading code) while re-checking Phase 1 completion for the MongoDB adapter, BullMQ tasks, and clustering.

- [x] **Fix `efc start dev` NODE_ENV ordering bug** — `packages/core/src/cli/commands/start.ts` now sets `NODE_ENV: 'development'` *after* `...process.env`, so it always wins regardless of an inherited `NODE_ENV=production`. Verified with the same repro that found the bug; typecheck + full test suite green. (Fixed 2026-07-19)
- [x] **Fix `efc doctor` false-negative on DATABASE_URL/JWT_SECRET** — `doctorCommand` in `packages/core/src/cli/commands/diagnostics.ts` checked `process.env` directly, but `efc doctor` never loads `.env` (unlike `efc start dev`, which injects it into a spawned child only). Added `readEnvFile()` so doctor checks both `process.env` and a parsed `.env` in cwd. Verified against the real `usage/` app — previously showed both as missing despite being set in `usage/.env`, now passes. (Fixed 2026-07-19)
- [x] **Schema-level "operator code" defaults** for `defineModel` — implemented `'$now'` (→ `new Date()`), `'$uuid'` (→ `crypto.randomUUID()`), `'$objectId'` (→ fresh Mongoose `ObjectId`), `'$timestamp'` (→ `Date.now()` number), `'$shortId'` (→ random base64url string) as sentinel strings resolved to per-document generator functions in `db/model.ts` (`resolveDefault`/`STATIC_DEFAULT_OPERATORS`). New `DefaultOperator` type exported from `types.ts` and the main entrypoint. Documented in `docs/api-reference/db.md` and `Skills/efc/api-surface.md`. Covered by `db/model.smoke.test.ts` (fresh-per-document generation, literal strings unaffected). (Added/expanded 2026-07-19)
- [x] **`defineModel` `ModelOptions` third argument** — `timestamps` was previously hardcoded to `{ timestamps: true }` with no way to disable or rename `createdAt`/`updatedAt`. Added `defineModel(name, schema, options?: ModelOptions)`; `options.timestamps` accepts `true | false | { createdAt?, updatedAt? }`, passed straight through to mongoose. Default unchanged (`true`), so existing models are unaffected. Exported `ModelOptions` from `types.ts` and the main entrypoint; documented in `docs/api-reference/db.md` (`ModelOptions` section) and `docs/guides/database.md`. Covered by `db/model.smoke.test.ts`. (Added 2026-07-19)
- [x] **`sequence` field option (real `$increment`)** — `FieldDefinition.sequence?: boolean | string`. `true` keys an internal atomic counter as `'<ModelName>.<field>'`; a string sets an explicit shared key. Assigned in a `pre('validate')` hook (before `required` runs, only on new docs, only when not already set) — not a `default` code, since `default` resolves synchronously and an auto-increment needs an async read-modify-write against a counters collection (`efc_counters`, `$inc` + upsert — safe under concurrent inserts). Top-level fields only, not inside nested array sub-schemas. Verified against a real local MongoDB (`db/model.integration.test.ts`): sequential uniqueness, shared counter keys across models, and explicit values aren't clobbered. (Added 2026-07-19)
- [x] **Request context + `$currentUser`/`$currentUser.<key>` default codes** — added `packages/core/src/context.ts` (`AsyncLocalStorage`-backed), wired into `ignite()` (every request wrapped before any other middleware) and `requireAuth` (populates the context with the verified JWT payload). Exported `getCurrentUser()` from `express-file-cluster/auth`. `default: '$currentUser'` resolves to the full payload; `` `$currentUser.<key>` `` plucks one field (e.g. `'$currentUser.id'`); both resolve to `undefined` outside a request / without `requireAuth`, never throw. This is a real capability change — `Skills/efc/what-not-to-invent.md`'s old "no request context" claim removed and replaced with accurate current state. Verified three ways: live-Mongo integration tests (`runWithContext` + `.create()`), and a full real HTTP round trip (`ignite()` → Bearer JWT → `requireAuth` → route handler → `.create()` → correct `createdBy`, status 201). (Added 2026-07-19)
- [x] Fixed a drive-by mongoose deprecation warning (`{ new: true }` → `{ returnDocument: 'after' }`) in both the new `nextSequence` counter helper and the pre-existing `update()` CRUD method, discovered while adding the sequence feature. Added an `update()` integration test — previously untested against a live DB. (Fixed 2026-07-19)
- [x] **Updated the marketing site's "Workspace" demo** (`client/workspace.js`) — its `FILES` object hardcodes its own copy of the model/route source shown in the simulated IDE (per its own header comment, "verbatim from /usage"), and was stale relative to `usage/` itself. Retrofitted the new features into natural, non-contrived spots: `User.verifyToken` and `Session.token` → `default: '$uuid'` (dropped the now-redundant manual `crypto.randomBytes()` calls in `register.ts`); `Admin` gained `adminNumber` (`sequence: true`) and `createdBy` (`default: '$currentUser.id'`), and `admin/admins/index.ts`'s `GET`/`POST` handlers were turned from TODO-stubs into real `Admin.find()`/`.create()` calls — the natural real-world case for both features together; `Role` demonstrates `ModelOptions.timestamps: false` paired with an explicit `createdOn: { default: '$now' }` field (the one non-redundant use of `$now`, only meaningful once auto-timestamps are off). Added a terminal-demo curl example showing the new response fields. Deliberately did **not** force `$objectId`/`$timestamp`/`$shortId` in — no natural fit found in this app's models; forcing them in would've meant contrived justifications. Every snippet was verified against the real framework over live HTTP requests before going in (not just checked for valid JS/HTML). (Updated 2026-07-19)
- [x] **Version bump**: `packages/core/package.json` `0.3.12` → `0.3.14` (checked `npm view express-file-cluster version` first — registry was already at `0.3.13`, one ahead of this repo's local `package.json`, so bumped to `0.3.14` to avoid a publish collision, not to `0.3.13`). `packages/create-efc-app` was **not** bumped — untouched this session — but note it has the same one-patch drift (local `0.4.12` vs published `0.4.13`); `publish.yml`'s "fail loudly if already published" guard will catch it if someone tries to publish before bumping. Synced version strings in `client/index.html` (hero badge + new changelog entry), `client/workspace.html` (status-bar chip), and `client/workspace.js` (demo `package.json`'s `express-file-cluster` dependency). Deliberately did **not** touch `README.md`, `packages/core/README.md`, `CLAUDE.md`, `docs/index.md`, or `Skills/efc/SKILL.md` — all still say "v0.3.10" (already stale before this session, flagged but out of scope; only `/client` was requested). (2026-07-19)
- [x] (Fixed 2026-10-10 — `enqueueTimeout`, see below.) **BullMQ `enqueue()` hangs indefinitely when Redis is unreachable** — reproduced: `enqueue('ValidTask', payload)` against an unreachable Redis never resolves or rejects (tested past 5s with no timeout). Unknown task names still fail fast (registry check is synchronous, unaffected). Not a crash — BullMQ/ioredis retry quietly in the background — but there's no fail-fast/circuit-breaker option, and nothing in the docs warns callers their request may hang. Explicitly deferred by product decision on 2026-07-19; revisit before Phase 1 exit.
- [x] (Resolved 2026-10-10 — see Phase 1 Completion Work.) Note: `mongoose` peer dependency range is `>=8.0.0` but the pinned devDependency is `^9.7.2`.
- [x] (2026-10-10: `mongo:7` service container added to `ci.yml`.) `db/model.integration.test.ts` (sequence + `$currentUser`, real MongoDB) self-skips when no MongoDB is reachable — confirmed it does (tested with an unreachable `EFC_TEST_MONGO_URL`), so it won't break the existing `.github/workflows/ci.yml` (no Mongo service container wired up there). Still: CI currently gets zero coverage of this file. Add a Mongo service container to `ci.yml` to actually run it.

---

## Phase 2 — Beta — ✅ complete 2026-10-10

Every item below is covered by tests that run in CI (MongoDB, MongoDB replica set, Redis and PostgreSQL services; e2e on Node 22 + 24).

- [x] **PostgreSQL adapter (Drizzle ORM)** — `defineModel` compiles to a Drizzle `pgTable` when the engine is `postgresql`; uuid ids, jsonb for embedded data, real `SEQUENCE`s, non-destructive `sync()` DDL, populate across models, `db` = pg `Pool`. One conformance suite (`db/engines.integration.test.ts`) runs every model feature against both engines.
- [x] **pg-boss task backend** — `tasks: { backend: 'pg-boss' }` on `databaseUrl`; one pg-boss queue per task, same retry semantics, cron, fail-fast enqueue, graceful drain (`integration/pgboss.test.ts`).
- [x] **Catch-all / wildcard routes** — `[...slug]` (≥1, `string[]`) and `[[...slug]]` (≥0), RegExp-mounted with named-param mapping.
- [x] **Request validation** — `export const schema` with any Standard Schema validator (zod ≥3.24, valibot, arktype) or zod-style `safeParse`; per method or file-wide; 400 with all issues; zod is not a dependency.
- [x] **Structured logging (`pino`) with request IDs** — `X-Request-Id` in/out, `req.id`/`req.log`, request-scoped `getLogger()`, per-request lines, built-in dev renderer, `logging` config; all `console.*` in core runtime replaced.
- [x] **Scheduled/cron tasks** — `schedule` + `timezone` on both backends; idempotent per-worker reconcile; stale schedules removed.
- [x] **Optional dynamic segments** — `[[id]]`; routes ordered by per-segment specificity.
- [x] **`efc db migrate / rollback / status / seed / studio`** — batches, Postgres advisory lock, tsx-or-dist runtime, `efc generate migration|seed`, read-only studio (`integration/db-cli.test.ts` drives the real binary).
- [x] **Dead-letter inspection** — `efc tasks failed | retry | purge` for BullMQ and pg-boss.

### `defineModel` gaps (found 2026-10-10) — all closed

- [x] `update()` / `updateMany()` run validators (Mongo `runValidators`; Postgres shared JS validator).
- [x] Typed embedded objects — nested-schema shorthand or `{ type: 'object', fields }`; arrays of embedded docs via `of: {...}` too.
- [x] `find` options — `sort`, `limit`, `skip`, `select` (plus `populate`).
- [x] `Model.raw()` — compiles on demand; returns the mongoose model / Drizzle table.
- [x] Typed `Filter<T>` / `Update<T>` — operators, dotted paths, `$and`/`$or` without casts.
- [x] Field validators — `min`, `max`, `minLength`, `maxLength`, `match`, custom (async) `validate`.
- [x] Indexes — `index`, compound, unique, text (both engines), TTL (MongoDB).
- [x] Bulk + aggregation — `createMany`, `updateMany`, `deleteMany` (counts), `aggregate` (MongoDB).
- [x] `transaction(fn)` — AsyncLocalStorage-joined; Mongo sessions / Drizzle tx.
- [x] Also: `ModelValidationError` (400 + issues), duplicate key → 409, malformed id → not found, `Model.drop()`.

### Found and fixed along the way

- [x] **`requestTimeout` was a phantom option** — typed and documented ("408 on exceed") but never implemented. Implemented, with a guard so a handler's late reply can't crash the error handler.
- [x] **`connectMongo()` returned `undefined` in native ESM** (read mongoose's CJS namespace binding) — `db` was undefined on MongoDB in built apps since before this phase.
- [x] **Optional peers bundled into `dist`** — `pg`/`drizzle-orm`/`pg-boss` as devDependencies only got inlined by tsup and broke at runtime; now optional `peerDependencies`. Lesson recorded in CLAUDE.md.
- [x] Driver loaders reported every import failure as "not installed"; now only genuinely missing modules.
- [x] Scaffolder: PostgreSQL + pg-boss selectable again; ~550 lines of Drizzle stubs removed (generated code is engine-agnostic); init migration; `db:*` scripts; REDIS_URL only for BullMQ.

### Not done — deliberately out of scope (and the late addition)

- [x] **Redis adapter (cache + session store)** — from plan.md's Phase 2 table, added 2026-10-10: `ignite({ cache })` with Redis or memory backends, `cache` API (`get/set/has/del/wrap/clear`), `cacheResponse()` middleware, and JWT session revocation (`revokeSession`, `revokeAllSessions`) enforced by `requireAuth`. Redis outages degrade to misses for cache calls; revocation checks reject with 503 by default (`onRevocationCheckError: 'allow'` to pass), revoke calls fail loudly. The memory backend lives in the cluster primary and workers share it over IPC. Scaffolded apps configure a cache (Redis if `REDIS_URL`, else memory), log out with `revokeSession` and revoke all sessions on password reset (`integration/cache.test.ts`, `integration/cluster.test.ts`, e2e logout replay on both stacks).
- No schema-diff migration generator (`efc db generate`) — migrations are hand-written around `sync()`.

---

## Phase 3 — Stable v1.0 (Q1 2027)

- [ ] Plugin system (`registerPlugin()`)
- [ ] WebSocket support (`export const WS = ...`)
- [ ] OpenAPI auto-generation from route exports
- [ ] OpenTelemetry distributed tracing
- [ ] `efc/testing` (`createTestApp()` for integration tests)
- [ ] `efc studio` — live route map + worker/queue dashboard
- [ ] Third-party security audit
- [ ] Benchmarks vs bare Express / Fastify
- [ ] Semver + LTS policy
- [ ] Docs site

---

## Phase 1 Follow-ups (found 2026-10-10)

- [x] **Scaffolder `cluster: true` regression** — `writeEntryPoint()` emitted a literal `cluster: true` again, forcing clustering under `efc start dev`. The regression test existed but `vitest.config.ts` only listed the `core` project, so it never ran. Added a `create-efc-app` project and fixed the generator.
- [x] **Removed unused root `node-pty` dependency** — imported nowhere; its native build failed `npm ci` on machines without build tools.
- [x] **Publish workflow red on main** — `create-efc-app` local `0.4.12` was already on npm. Bumped to `0.4.14` (core → `0.3.16`).
- [x] Status strings synced to `v0.3.16` in `CLAUDE.md`, `packages/core/README.md`, `docs/index.md`, `Skills/efc/SKILL.md` and `client/` (hero badge, workspace status bar + demo `package.json`, new changelog entry).

## Phase 1 Completion Work (2026-10-10)

Found by actually running each exit criterion end to end, not by reading code:

- [x] **`efc build prod` never produced a runnable app** — tsup bundled only `src/index.ts`; routes/tasks are discovered by filesystem scan at runtime, so `dist/` had none and the server fell back to `src/api/*.ts` (crashing on `.js` imports, or serving nothing in a dist-only Docker image). Now transpiles `src/**` + `efc.config.ts` unbundled → `dist/src/**`; `efc start prod` runs `dist/src/index.js`. JS projects build too (typecheck skipped without `tsconfig.json`).
- [x] **`npx create-efc-app` failed `npm install` on Node 22 (npm 10.9)** — `vitest@^4.1.9` crashes npm 10's arborist (`Cannot read properties of null (reading 'edgesOut')`), reproduced with the published `0.3.15` too. Scaffolded projects now pin `vitest@^5.0.3`.
- [x] **Scaffolder offered PostgreSQL / pg-boss** — neither is wired in the runtime, so those choices generated broken projects. Prompts now show MongoDB / BullMQ as fixed until Phase 2.
- [x] **Cluster primary hung forever on primary-only SIGTERM** (`docker stop`, k8s) — workers were never signalled and the primary had no forced-exit timer. Primary now relays SIGTERM to workers and force-exits after `timeoutMs + 2s`; workers ignore a duplicate signal instead of dying mid-drain.
- [x] **`efc start prod/dev` didn't forward signals** to the spawned server and reported exit 0 for a signal-killed child.
- [x] **`enqueue()` fail-fast** — offline queue disabled on the producer connection + `tasks.enqueueTimeout` (default 5000 ms). Rejected jobs are never queued later.
- [x] **`retries` off-by-one** — was passed straight to BullMQ `attempts` (total runs); now `retries + 1`, matching the docs.
- [x] **`parseRedisUrl` dropped username, `/db` and `rediss://` TLS** — hosted Redis (Upstash, Redis Cloud, ElastiCache TLS/ACL) couldn't connect.
- [x] **`gracefulShutdown()` now drains the BullMQ worker** before exit.

### Decisions resolved

- [x] `create-efc-app` runs `npm install -g express-file-cluster` after scaffolding — kept as intended behavior (confirmed 2026-10-10).
- [x] mongoose versions aligned (2026-10-10): peer `^8.0.0 || ^9.0.0` (was an open-ended `>=8.0.0` that admitted untested v10), scaffolder `^9.7.2` (was `^8.0.0`). DB smoke + live-Mongo integration suites verified green on both 8.24.5 and 9.7.2. Smoke tests moved off deprecated `validateSync()` to `validate()`.

## What to Build Next — Phase 3 (Priority Order)

1. **`efc/testing` — `createTestApp()`** — the integration tests here hand-roll tmp projects + `ignite()`; ship that as a supported helper
2. **OpenAPI generation** — `schema` exports are Standard Schema validators; derive request schemas (+ `meta`) into an OpenAPI document
3. **OpenTelemetry tracing** — request IDs and the request context are already in place
4. **Plugin system** (`registerPlugin()`)
5. **WebSockets** (`export const WS = ...`)
6. Benchmarks vs bare Express / Fastify, security audit, semver/LTS policy, docs site
