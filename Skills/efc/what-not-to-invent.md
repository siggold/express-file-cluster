# EFC — What Does NOT Exist

This module is the anti-hallucination guard. Before suggesting, generating, or writing EFC code, check this list. If something appears here, **it does not exist in the codebase** — do not generate it, reference it, or imply it works.

---

## Import paths that do NOT exist

```ts
// ❌ DOES NOT EXIST
import { ... } from 'express-file-cluster/db'
import { ... } from 'express-file-cluster/router'
import { ... } from 'express-file-cluster/cluster'
import { ... } from 'express-file-cluster/middleware'
import { ... } from 'express-file-cluster/errors'
import { ... } from 'express-file-cluster/config'
import { ... } from 'express-file-cluster/models'
```

Only three sub-paths exist: (no suffix), `/auth`, `/tasks`.

---

## Functions that do NOT exist

```ts
// ❌ NOT exported from any EFC path
createApp()
createServer()
useMiddleware()
addRoute()
registerRoute()
mountRoute()
defineRoute()
defineMiddleware()
defineModel()          // ← WAIT — this DOES exist, from main path
createModel()          // ← does NOT exist (it's defineModel, not createModel)
getModel()             // ← does NOT exist as a public export
useDatabase()
connectDatabase()
createTask()           // ← does NOT exist (it's defineTask)
addTask()
scheduleTask()         // ← does NOT exist — use defineTask({ schedule: '<cron>' }, handler)
validate() / useSchema() // ← does NOT exist — use `export const schema` in the route file
createLogger()         // ← does NOT exist — use logger / getLogger() from the main path
withTransaction()      // ← does NOT exist — it's transaction(fn) from the main path
withAuth()             // ← does NOT exist
protect()              // ← does NOT exist
authenticate()         // ← does NOT exist (it's requireAuth)
```

---

## Configuration patterns that do NOT exist

```ts
// ❌ No automatic efc.config.ts loading — ignite() does NOT read efc.config.ts
// The config file is informational only. You must import it yourself and pass it:
import config from './efc.config';
ignite(config);   // you wire this yourself

// ❌ No global middleware file (middlewares.ts or similar)
// Middleware is only wired via ignite({ globalMiddlewares }) or route exports

// ❌ No src/middleware/ auto-scanning
// EFC does NOT automatically scan a middlewares directory

// ❌ No plugins system yet (Phase 3)
ignite({ plugins: [...] })     // does NOT exist

// ❌ No apiDir / tasksDir / migrationsDir options — all are conventions:
//    src/api, src/tasks (non-recursive), src/migrations, src/seeds

// ✅ Request context DOES exist now (added 2026-07-19) — every request run through
// ignite() is wrapped in an AsyncLocalStorage context (packages/core/src/context.ts),
// and requireAuth populates it with the verified JWT payload:
import { getCurrentUser } from 'express-file-cluster/auth';
getCurrentUser()   // Record<string, unknown> | undefined — the auth payload, or
                   // undefined outside a request / on a route without requireAuth

// ❌ There is no general-purpose ctx object beyond the user payload — no
// import { ctx } from 'express-file-cluster', and no way to stash arbitrary
// per-request values yourself. getCurrentUser() is the only thing exposed.
```

---

## Route file features that do NOT exist

```ts
// ✅ Special exports: HTTP methods, `middlewares`, `schema` (validation), `meta` (dashboard docs).
// ❌ Everything else is ignored:
export const config = { ... }         // ignored
export const description = '...'      // ignored

// ❌ Default export is NOT used by the router
export default async function(req, res) { ... }   // NOT called as a route handler

// ✅ Catch-all / optional segments DO exist: [...slug] (≥1 segment, req.params.slug is string[]),
//    [[...slug]] (≥0), [[id]] (optional). A catch-all must be the LAST segment:
// src/api/[...slug]/edit.ts  → rejected at startup

// ❌ schema validators are not auto-detected from TypeScript types — export real validators
// (zod/valibot/arktype or anything with safeParse). EFC does not depend on zod.
```

---

## Task features that do NOT exist

```ts
// ❌ Task sub-directories not scanned
// src/tasks/email/SendEmail.ts   → NOT registered (only top-level files)

// ✅ Cron DOES exist: defineTask({ schedule: '0 * * * *', timezone: 'UTC' }, handler) — payload is {}
// ✅ pg-boss DOES exist: ignite({ tasks: { backend: 'pg-boss' } }) — uses databaseUrl
// ❌ No per-run payload for scheduled runs (always {}) and no "every N ms" interval option
// ❌ No built-in parent/child job tracking or job progress API
// ❌ No dead-letter web UI — use `efc tasks failed | retry | purge`
```

---

## CLI commands that do NOT exist

```bash
efc lint            # NOT IMPLEMENTED
efc deploy          # NOT IMPLEMENTED
efc db generate     # NOT IMPLEMENTED — no schema-diff migration generator; write migrations
                    # by hand (efc generate migration <name>) and call Model.sync()
efc db reset / fresh # NOT IMPLEMENTED
```

Implemented commands: `start dev|prod`, `build prod`, `run tests`, `generate route|task|middleware|migration|seed`, `db migrate|rollback|status|seed|studio`, `routes`, `tasks` (+ `failed|retry|purge`), `doctor`, `--version`.

---

## Database features that do NOT exist

```ts
// ✅ PostgreSQL DOES exist (Drizzle) — same defineModel API. ids are UUIDs there.
// ✅ transaction(fn) DOES exist (main path). MongoDB needs a replica set.
// ✅ Migrations DO exist (efc db migrate) — but defineModel does NOT create PostgreSQL
//    tables on its own: call Model.sync() from a migration. Using a model whose table
//    doesn't exist fails with 'relation "<table>" does not exist'.
// ❌ No automatic schema diffing / ALTER of existing columns — sync() only ADDS missing
//    columns (nullable) and indexes; renames/type changes need hand-written db.query().
// ❌ No joins in the model API — populate does a second query; for SQL joins use
//    Drizzle via Model.raw() or db.query().
// ❌ aggregate() is MongoDB-only (rejects on PostgreSQL).
// ❌ TTL indexes (expireAfterSeconds) are MongoDB-only.
// ❌ Filter operators beyond $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or
//    are rejected on PostgreSQL (they pass through to mongoose on MongoDB).
// ❌ Update operators beyond $set $unset $inc $push $pull likewise.

// db is the native client: mongoose Connection on MongoDB, pg Pool on PostgreSQL.
// db.query() exists only on PostgreSQL; db.model() only on MongoDB.

// ❌ '$increment' is NOT a `default` operator code, and never will be —
// mongoose resolves `default` synchronously, but an auto-increment needs an
// async read-modify-write against a counters collection. That functionality
// DOES exist (added 2026-07-19), just under a different field property:
{ orderNumber: { type: 'number', sequence: true, required: true } }
// FieldDefinition.default supports:
//   '$now' | '$uuid' | '$objectId' | '$timestamp' | '$shortId'
//   | '$currentUser' | `$currentUser.${string}`
// (see db/schema.ts STATIC_DEFAULT_OPERATORS / resolveDefault)
```

---

## Auth features that do NOT exist

```ts
// ✅ requireAuth('admin') DOES exist — it's an overload, not a separate function.
// Bare `requireAuth` just verifies the JWT. Called with role names it returns a
// middleware that also checks payload.role. Both forms use the same export.

// ❌ No refresh token mechanism in the framework itself
// (the create-efc-app scaffolder generates an app-level /auth/refresh route
// that stores a rotating refresh token in the DB — that's app code, not core)
refreshToken()          // does NOT exist as a core export

// ❌ No token blocklist / invalidation list
// revokeToken() only clears the cookie — the JWT remains cryptographically valid

// ❌ No per-route strategy override
// authStrategy is global — set once in ignite()
```

---

## Environment variables that EFC does NOT read automatically

`ignite()` reads app config only from the `EFCConfig` object it's given — it does not grab any of the following from `process.env` itself. Read them yourself (typically in `efc.config.ts`) and pass them in:

```
PORT              — NOT read by ignite(); pass config.port explicitly
                    (or: port: process.env.PORT ? Number(process.env.PORT) : undefined)
DATABASE_URL      — NOT read by ignite(); pass config.databaseUrl explicitly
                    (or: databaseUrl: process.env.DATABASE_URL)
JWT_SECRET        — NOT read by ignite(); pass config.jwtSecret explicitly
                    (or: jwtSecret: process.env.JWT_SECRET)
JWT_EXPIRES_IN    — NOT read by ignite(); pass config.jwtExpiresIn explicitly
                    (or: jwtExpiresIn: process.env.JWT_EXPIRES_IN)
COOKIE_DOMAIN     — NOT read by ignite(); pass config.cookieDomain explicitly
                    (or: cookieDomain: process.env.COOKIE_DOMAIN)
CORS_ORIGINS      — NOT read by ignite(); pass config.cors.origin explicitly
                    (or: cors: { origin: process.env.CORS_ORIGINS?.split(',') } )
REDIS_URL         — NOT read by ignite(); pass tasks.redisUrl explicitly
                    (or read it yourself: tasks: { redisUrl: process.env.REDIS_URL })

(The standalone CLI commands — efc db, efc tasks failed, efc doctor — DO read
DATABASE_URL / REDIS_URL from the environment or .env themselves.)
```

`NODE_ENV` is the one env var the framework *does* still read directly (cluster-in-production default, dev-only dashboard toggle, auth cookie `Secure` flag) — see `pre-flight.md`.

---

## Common wrong patterns

```ts
// ❌ Calling enqueue without configuring tasks in ignite()
ignite({ port: 3000 })   // no tasks config
await enqueue('SendEmail', payload)  // throws: Task queue not initialised

// ❌ Calling requireAuth before ignite() / configureAuth()
// In tests that mount handlers without calling ignite(), requireAuth will throw

// ❌ Accessing db before Pre-Flight completes
// In module-level or import-time code:
const conn = db.model('User')  // throws: db not ready

// ❌ Passing apiDir at all — it is not an option; src/api is found by convention
// (dev: src/api via tsx; prod: dist/src/api, emitted by `efc build prod`)

// ❌ Forgetting `efc db migrate` on PostgreSQL before first boot — tables don't exist yet
```
