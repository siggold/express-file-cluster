# EFC — Implementation Checklist

> Status as of 2026-10-10. **Phase 1 (Core MVP) and Phase 2 (Beta) complete** — see each section; Phase 3 is next.

---

## Learning website

- [x] Rebuild learn-efc as an article-first backend handbook: web and server fundamentals → Node.js and Express → EFC and databases → production, initialization, and CORS.
- [x] Add original Express/EFC comparisons, visual concept diagrams, selected interactive checkpoints, searchable topics, responsive reading navigation, and browser-local reading progress.

---

## Phase 0 — Design & Planning

- [x] Define core API (`ignite()` options, route + task conventions)
- [x] Write `plan.md`
- [x] Decide package name & npm scope — unscoped `express-file-cluster`, `create-efc-app`, and `express-file-cluster-mcp`.
- [x] Set up contribution guidelines & repo standards — `docs/contributing/index.md`, ESLint/Prettier, AGENTS.md and CI.
- [x] Choose test runner (Vitest) + CI setup

---

## Phase 1 — Core MVP

### 1.1 Project Bootstrap

- [x] Initialise monorepo (`packages/core`, `packages/create-efc-app`)
- [x] TypeScript build (`tsup`) + dual CJS/ESM output
- [x] ESLint + Prettier config
- [x] GitHub Actions: lint + typecheck + build + test on every PR (`.github/workflows/ci.yml`)
- [x] Adapter packaging decision — MongoDB and PostgreSQL adapters ship inside `packages/core/src/db`; the originally planned separate `packages/adapters` package is superseded.

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
- [x] `efc tasks` — list top-level `.ts`, `.js`, `.mts`, and `.mjs` tasks without importing them
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

### Double-check findings (2026-10-11)

A second full pass — every todo item re-verified against the code, plus the paths no test covered — found and fixed:

- [x] **JavaScript projects never worked**: generated `efc.config.js` contained TypeScript syntax; `efc start dev` required tsx (not installed in JS projects); `efc build prod` failed because tsup can't load without typescript. Now: JSDoc-typed config, `node --watch` dev mode, and the build copies JS as-is. New `node --check` unit test over every generated JS file, and a JavaScript stack in the e2e.
- [x] **PostgreSQL update/filter parity gaps**: dotted `$unset` was silently ignored; two dotted `$set`s on one object overwrote each other; dotted `$inc`/`$push`/`$pull` errored; missing parent objects weren't created; dotted writes weren't validated; `$ne`/`$nin` on array fields errored. All fixed and covered by a new conformance case on both engines.
- [x] **Studio DNS-rebinding guard**: non-loopback `Host` headers are refused (403).
- [x] e2e now also covers `efc start dev` and `efc db status --dist` on every stack, with an isolated database per stack.
- [x] Stale references to the removed `usage/` app removed from CLAUDE.md, the contributing guide and the Skills card.

### Release rehearsal (2026-10-13)

npm publishing is blocked for a few days, so the release was rehearsed against a throwaway local registry (Verdaccio): both packages published there, the real interactive `npx create-efc-app` driven through a pseudo-terminal, and each generated app taken through its outro with the **global** `efc` — migrate, dev server, build, production server, auth + logout replay, SIGTERM. Now repeatable: `scripts/release-rehearsal/run.sh`.

- [x] **Global `efc` broke `efc db migrate`** — the scaffolder installs `efc` globally and its outro says to run `efc db migrate`, but the global copy resolved database drivers from its own install ("mongoose is not installed") and would have loaded a second framework instance. A global `efc` now hands the whole invocation to the project's local install (`integration/cli-delegation.test.ts`).
- [x] Rehearsal passes for MongoDB + BullMQ, PostgreSQL + pg-boss, and JavaScript + PostgreSQL.

### PostgreSQL feels like MongoDB (2026-10-13)

Goal: define a model and use it — no table chores, on either engine.

- [x] **Auto schema sync** (`autoSync`, default on): a model's first use reconciles its table/collection and indexes, like mongoose's autoCreate/autoIndex. Postgres runs it in one transaction under an advisory lock (safe with every cluster worker syncing at boot); `autoSync: false` also turns off mongoose's auto-indexing, and a missing table then gets a clear error.
- [x] **Reconciling sync** (introspect → plan → apply): add columns, convert changed types (`USING` casts), drop stale `NOT NULL`s, rebuild enum `CHECK`s (`NOT VALID`), create declared indexes and drop EFC-named ones no longer declared. Never drops columns or rows. `sync({ dryRun })` returns the plan; MongoDB uses `diffIndexes()`.
- [x] **Undeclared fields like mongoose**: ignored on writes (incl. dotted update paths), absent in filters, ignored in sort/select — Postgres used to answer 400.
- [x] **`efc db sync [--dry-run]`** for every model in `src/model(s)/`; **studio Structure view** (Postgres columns/types/indexes; MongoDB sampled fields + indexes).
- [x] Scaffolder outro no longer needs `efc db migrate`; e2e and the release rehearsal now register users on a fresh database before any migration, then check `efc db sync --dry-run` reports everything in sync.

### Not done — deliberately out of scope (and the late addition)

- [x] **Redis adapter (cache + session store)** — from plan.md's Phase 2 table, added 2026-10-10: `ignite({ cache })` with Redis or memory backends, `cache` API (`get/set/has/del/wrap/clear`), `cacheResponse()` middleware, and JWT session revocation (`revokeSession`, `revokeAllSessions`) enforced by `requireAuth`. Redis outages degrade to misses for cache calls; revocation checks reject with 503 by default (`onRevocationCheckError: 'allow'` to pass), revoke calls fail loudly. The memory backend lives in the cluster primary and workers share it over IPC. Scaffolded apps configure a cache (Redis if `REDIS_URL`, else memory), log out with `revokeSession` and revoke all sessions on password reset (`integration/cache.test.ts`, `integration/cluster.test.ts`, e2e logout replay on both stacks).
- Schema-diff migration generation was outside Phase 2 and has since shipped in Phase 3 (`efc db generate`); hand-written migrations remain supported.

---

## Phase 1/2 audit follow-up — 2026-10-30

- [x] `compose` forwards callback errors and Express route/router skip signals without executing later composed handlers; HTTP regression coverage.
- [x] Catch-all paths split raw captures before URI-decoding once, preserving encoded slashes and literal percent signs; both required and optional catch-alls tested under a base path.
- [x] Generated password changes verify User/Admin credentials, persist a new hash, clear refresh credentials and revoke access tokens; generated-handler coverage across all model/language variants.
- [x] Unimplemented 2FA and device-session handlers return authenticated 501 responses rather than fake success or device lists; docs and registry label these extension points. Device-session implementation remains outside the delivered framework scope; 2FA is implemented by the follow-up below.
- [x] Reconcile superseded adapter-package planning and the stale migration-generator exclusion.

## Two-factor authentication follow-up — 2026-10-30

- [x] Init and account-security registry prompt: TOTP, email OTP, or both; users/admins enroll one allowed method. Init adds SMTP mailer setup for email choices.
- [x] Password-confirmed enrollment and disable; full password+factor login shared by login/verify, token issuance gated, atomic replay prevention, expiry and purpose binding, rate limits and cache failure rejection.
- [x] Independently encrypted TOTP secrets, keyed email digests, no secrets in record responses; enrollment/disable revoke access and refresh tokens. Refresh rotation rejects replay and OAuth cannot bypass 2FA.
- [x] RFC vectors, ciphertext tampering, User/Admin flows across all model/language variants, concurrent code consumption and email expiry/delivery failures covered by regression tests.
- [ ] Recovery codes / automated lost-device recovery (not implemented).

## Phase 3 — Stable v1.0 (Q1 2027)

- [ ] Plugin system (`registerPlugin()`)
- [x] WebSocket support (`export const WS = ...`) — since 0.11.0
- [x] OpenAPI auto-generation from route exports — since 0.11.0
- [x] OpenTelemetry distributed tracing — unreleased; app-owned SDK/exporter, HTTP/templates/errors, native task propagation/retries, threads and shutdown.
- [x] CommonJS package loading — tsup shims translate `import.meta.url` used by shared task/CLI modules; regression checks exercise both built testing exports.
- [x] `express-file-cluster/testing` — `createTestApp()` mounts real route trees with shared production HTTP middleware/error handling, explicit fixture directory, optional auth, no listener/services/cwd mutation. Guide, API reference, package export and regression tests.
- [ ] `efc studio` — live route map + worker/queue dashboard
- [ ] Third-party security audit
- [ ] Benchmarks vs bare Express / Fastify
- [ ] Semver + LTS policy
- [ ] Docs site
- [x] Zero `npm audit` findings (2026-10-28, 0.9.2): scaffolded auth drops `bcrypt` (vulnerable `tar` via
      `@mapbox/node-pre-gyp`) for `hashPassword`/`verifyPassword` in `express-file-cluster/auth` (node:crypto
      scrypt); nodemailer ^10.2.1 + esbuild override in scaffolded apps; repo lockfile refreshed (zod, vite,
      vitest, qs, body-parser, …)
- [x] Friendlier `connectPostgres` error when `DATABASE_URL` has no password (`SASL: client password must be a
      string`) + scaffolder note to create the database/user (bugs/e2e-bugs.txt) — 0.9.5, with the other
      connection errors (pg + Mongo) and a boot-time warning when `workers × pool` exceeds `max_connections`

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

0. **Data layer that competes with Prisma** — [`prisma-parity-plan.md`](./prisma-parity-plan.md): one shared foundation (inferred types, validation, auto-sync) under three APIs — portable `defineModel` (today's), PostgreSQL-native `defineTable` (Prisma-style queries, real relations/joins, SQL types) and MongoDB-native `defineCollection` (typed pipelines, `$lookup`, geo/text, bulkWrite, change streams); no cross-engine emulation. Milestones M1–M7.
   - [x] **M1** — inferred types (`InferRecord` / `InferCreate`, scaffolds without interfaces), engine-guard plumbing for the native APIs, portable `upsert` / `updateOne` / `deleteOne` / `exists` / `distinct`; nested dates revived on PostgreSQL
   - [x] **M2** — `defineTable`: SQL types (integer, bigint, decimal, uuid, json, varchar, native arrays/enums), serial/bigserial ids, snake_case naming; Prisma-style findMany/findUnique/count/aggregate/groupBy, create/createMany/update/updateMany/upsert (ON CONFLICT)/delete, cursor pagination, select/omit/distinct; shared pgTable layer
   - [x] M3 relations · [x] M4 schema lifecycle · [x] M5 `defineCollection` · [x] M6 query logging/metrics, editable studio, pool settings, bounded prepared statements and strict 10% benchmarks — complete; `bench/results/m6-validation.md` · [x] M7 docs

1. **Completed:** `express-file-cluster/testing` — `createTestApp()` for route integration tests; service boot remains covered by `ignite()` tests.
2. **OpenAPI generation — implemented in 0.11.0** — `schema` exports are Standard Schema validators; derive request schemas (+ `meta`) into an OpenAPI document
3. **OpenTelemetry tracing — implemented, unreleased** — HTTP/native task propagation, retries, threads, correlated logging and app SDK shutdown. Next: plugin system.
4. **Plugin system** (`registerPlugin()`)
5. **WebSockets — implemented in 0.11.0** (`export const WS = ...`)
6. Benchmarks vs bare Express / Fastify, security audit, semver/LTS policy, docs site

## M6 completion — 2026-10-30

- [x] Query logging, slow-query and N+1 detection; bounded opt-in process-local metrics with counters, latency summaries, overflow reporting, detached snapshots and reset.
- [x] Editable studio and both driver pool settings verified through live integration tests.
- [x] PostgreSQL named statements: 100-name default per-connection budget, transaction support, unnamed fallback, opt-out, schema-sync invalidation and safe pooled query error release; native db Pool unchanged.
- [x] Nightly 10% gate, strict coverage/timing validation, exact sample/warmup allocation, harness unit tests in PR CI and nightly workflows.
- [x] Local release rehearsal: all three scaffold/CLI journeys and packaged MCP startup/resources/tools passed.
- [x] Lint/typecheck/build; 458 tests passed, 36 skipped, 32 additional scaffold/install e2e tests, five harness tests; all twelve benchmark operations pass against the unchanged baseline. Details: `bench/results/m6-validation.md`.

## Auth and testing regression fixes — 2026-10-30

- [x] Authenticated logout clears stored refresh credentials for User/Admin and cookie/bearer callers.
- [x] Password snapshot CAS and authentication-time revocation prevent in-flight old-password logins from reviving sessions.
- [x] CommonJS test-helper bridge shares ESM route auth/context; packaged auth regression coverage.
- [x] Validation: lint, typecheck and build passed; full live-service suite including scaffold/install e2e: 507 passed, 4 skipped (51 files).

- [x] Patch 0.10.2: synchronize package/scaffold/site versions and changelog; commit tested M6 and initial auth/testing regression fixes.

## Additional auth review — 2026-10-30

- [x] Commit 0.10.2 checkpoint without co-author: `ca6d717`.
- [x] Atomic reset-token consumption and database expiry checks; revoke refresh credentials and pending challenges on reset, preserve active 2FA; invalidate reset links on password change.
- [x] Mixed ESM/CJS middleware shares auth, context and revocation/cache state.
- [x] Custom auth-entity logout propagates revocation failures.
- [x] Validation: lint/typecheck/build passed; full suite with live MongoDB/PostgreSQL/Redis and scaffold/install e2e: 528 passed, 4 skipped (52 files).

- [x] Release CI: build workspace packages before type checking cross-workspace test imports, including the npm publish workflow.

## 0.11.0 OpenAPI + WebSockets

- [x] OpenAPI 3.1 generation, opt-in endpoint, standalone directory generation, schema adapters/components, optional-path expansion and operation overrides.
- [x] WS route exports, shared middleware/auth/context, origin and payload limits, heartbeat, upgrade timeout and graceful drain.
- [x] Guides, references and agent cards updated.
- [x] Validation: full live-service + scaffold e2e run passed 541 tests (4 skipped). After the named-schema correction, final live core/integration/unit run passed 507 tests (35 scaffold e2e cases intentionally not repeated; 4 other skips). Named-schema regression passes; lint/typecheck/build pass. Official OpenAPI 3.1 schema validation and generated-reference resolution pass.

### 0.11.0 OpenAPI/WS review fixes (2026-10-31)

- [x] Reject pipelined upgrades without uncaught socket-assignment errors.
- [x] Detect OpenAPI endpoint collisions against real routes, including hidden/protected GET and HEAD.
- [x] Destroy pending upgrade sockets during shutdown rather than waiting for middleware deadlines.
- [x] Preserve object-union query fields/requirements and the complete query schema; fail clearly for unrepresentable shapes.
- [x] Match object query serialization to Express deepObject bracket syntax.
- [x] Deduplicate equivalent optional path expansions with the correct greedy parameter binding.
- [x] Reject overflowing payload and timer configuration values.
- [x] Add regression coverage for all seven findings and update guides, API references and skill cards.
- [x] Final validation: lint, typecheck, all package builds and `git diff --check` pass. Repository suite: 329 passed / 226 skipped (database-dependent and opt-in e2e coverage skipped in this run), including all 22 OpenAPI/WS tests. Official OpenAPI schema validation, local-reference resolution and unique path-shape checks pass; the original isolated pipelining crash reproduction exits cleanly.

### 0.11.0 OpenAPI follow-up fixes (2026-10-31)

- [x] Document array query keys using bracket syntax and verify one/multiple items against real request validation.
- [x] Keep external query-field refs without attempting to resolve them as local pointers.
- [x] Infer optional request bodies from converted-schema acceptance of Express’s empty body, preserving required bodies and explicit overrides without executing validators.
- [x] Add regressions and update guides, API reference, skill card and framework rules.
- [x] Final validation: lint, typecheck and all package builds pass; all 26 OpenAPI/WS regressions pass, and the full repository run passes (333 passed / 226 skipped, including database-dependent and opt-in e2e skips). Updated document passes the official OpenAPI schema check.

### 0.11.0 release preparation

- [x] Synchronize package/lock/scaffold versions, release notes, public site and bundled documentation.
- [x] Prepare release artifacts with all ten reviewed fixes and regression coverage; publication runs through the upstream main-branch workflow after CI/e2e. Commits use the configured author without co-authors.

### Unreleased OpenTelemetry implementation

- [x] Opt-in HTTP spans, W3C parentage, route templates, status/error/abort lifecycle and trace-correlated logging.
- [x] Native BullMQ/pg-boss propagation, unchanged payloads, per-attempt errors and clean task auth/request scopes.
- [x] Worker-thread/CJS nested enqueue parentage and app SDK shutdown after drain.
- [x] SDK-backed unit, real Redis/PostgreSQL and built worker-thread/SIGTERM regressions.
- [x] Update guides, API references, skill cards, runtime rules and backend upgrade requirements.
- [x] Final validation: all workspace builds, lint/typechecks and diff checks pass; repository run 469 passed / 101 skipped (MongoDB-dependent and opt-in e2e cases skipped), including all 11 tracing regressions with real Redis, temporary PostgreSQL, CJS route/thread enqueue and SIGTERM SDK drain. Runtime dependency audit: 0 findings.

### Repeated production-hardening review (2026-10-31)

- [x] Pass 1: reproduce/fix thread exit hangs/handle leaks, async middleware crashes, partial-response hangs, pg-boss payload collisions and shutdown dependency/failure ordering.
- [x] Pass 2: reproduce/fix response-cache user/method collisions, explicit HEAD shadowing, wrap failure poisoning and namespace races; add cookie/Vary/cache-control/serialization guards.
- [x] Pass 3: reproduce/fix revoked-session revival from memory pressure and shorter token lifetimes, domain-cookie clearing, auth timeout races, IPC disconnect hangs and rate-limit input/counter isolation.
- [x] Prevent Redis submissions after a readiness timeout and reject null pg-boss acknowledgments; document uncertain in-flight enqueue outcomes.
- [x] Fresh review: isolate worker progress frames from internal commands; replay serialized cache bytes without applying JSON replacers twice.
- [x] Full live-service + replica-set regression, scaffold e2e, static/type/build checks, and a fresh review after fixes. Full run: 598 passed / 4 backend-inapplicable skips, including 35 generated-app e2e cases. After the final JSON-byte regression/fix: 564 unit/integration tests passed, 35 e2e cases intentionally excluded from that repeat and 4 backend-inapplicable cases skipped; all 8 response-cache hardening regressions pass. MongoDB standalone/replica set, PostgreSQL and Redis were available; built CJS/thread/SIGTERM test also verifies cache remains usable while a job drains. Lint, typecheck, all package builds and diff checks pass. These checks do not certify deployment-specific load behavior or replace an independent security audit.

### 0.12.0 release

- [x] Publish all three packages through upstream main after CI and verify npm latest — published 2026-10-31 (siggold#37), tagged `v0.12.0` with GitHub releases for v0.5.0–v0.12.0.
- [ ] Publish all three packages through upstream main after CI and verify npm latest.

### Learn EFC hosting

- [x] Add three-job app workflow: lint/typecheck/content tests, standalone build/HTTP smoke tests, then upstream-main SSH deployment with pinned host identity and health-check rollback.
- [x] Document the namespaced Actions secrets, release directory layout, Node.js 24 prerequisite, systemd service, and Nginx proxy setup.
- [x] Install checksum-verified Node.js 24.22.2 and the systemd/Nginx setup on the hosting server; use the public server IP in canonical URLs and share images.
- [x] Pin deployment and systemd to a dedicated Node.js 24 runtime so Ubuntu package installs cannot replace the service's runtime; report failed activation lines in workflow logs.
- [x] Prepare learn.expressfilecluster.com canonical URLs, Nginx hostname, and HTTPS/automatic-renewal setup documentation.
- [x] Verify the domain's DNS, issue its HTTPS certificate, and enable Certbot's automatic renewal timer.
- [x] Verify public and origin HTTPS after correcting Oracle ingress to TCP 443, and pass Certbot's renewal simulation.

- [x] Add a dedicated Learn EFC section and desktop/mobile navigation and footer links to the marketing homepage (2026-10-31).
