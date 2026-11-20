# Changelog

All three packages (`express-file-cluster`, `create-efc-app`, `express-file-cluster-mcp`) are released
together under one version. Newest first. The public site's changelog (`client/index.html#changelog`)
mirrors this file — see `AGENTS.md` §5.

## Unreleased

- Include `.mjs` and `.mts` task files in `efc tasks` and skip directories.

## 0.12.0 — 2026-10-31

- Production hardening: catch async middleware failures, prefer explicit HEAD handlers, close partial error responses, preserve pg-boss reserved-key payloads, and make thread/shutdown lifecycles deterministic, with isolated thread protocol frames.
- Protect per-user cache identities and session revocations under memory pressure; retain user cutoffs across token-lifetime changes, clear domain-scoped cookies, and stop auth after timeout. Response caching honors method/variant/cookie/cache-control boundaries and replays exact JSON bytes; cache.wrap and IPC recover cleanly. Queue deadlines prevent late readiness submissions, and documentation describes uncertain in-flight acknowledgments and idempotency.
- Opt-in OpenTelemetry instrumentation for HTTP and background tasks, with W3C parentage, retry/thread propagation, trace log fields and app-owned SDK shutdown after drain. SDK/exporter setup remains application-owned.
- Mixed ESM/CommonJS route and task modules share their queue registry/enqueue implementation, preserving producer context across formats.
- Upgrade optional queue peers to BullMQ 5.79.1+ or pg-boss 12.38.0+ for the native tracing hooks; task payloads remain unchanged.

## 0.11.0 — 2026-10-31

- **OpenAPI:** opt-in OpenAPI 3.1 JSON generation from HTTP routes, request validators and metadata, with `generateOpenAPI()`, offline generation, schema adapters, components and operation overrides.
- **WebSockets:** file `WS` exports on the HTTP server share middleware, authentication, validation, params and async context; include origin checks, payload limits, heartbeat and graceful draining.
- **Reliability:** reject pipelined upgrades safely, drain pending handshakes, bound payload/timer settings, and protect hidden routes from document URL collisions. Preserve union query fields, schema references and optional bodies; match object/array query encoding and collapse equivalent optional paths.
- **Upgrade:** update all three packages together. OpenAPI remains opt-in; WS support activates when a route exports `WS` and can be disabled with `websocket: false`. Existing HTTP routes retain their behavior. WebSocket broadcasts remain worker-local and authentication is checked at the handshake.

## 0.10.2 — 2026-10-30

- **Auth fixes:** authenticated User/Admin logout invalidates stored refresh credentials, including
  bearer callers. Login checks the verified password snapshot before persisting refresh credentials;
  authentication-time revocation prevents in-flight old-password logins from reviving sessions.
- **Recovery and mixed-module fixes:** reset links are consumed atomically with a fresh DB expiry
  check; reset clears refresh credentials and pending challenges while preserving active 2FA.
  Password changes invalidate reset links. Custom-entity logout propagates revocation failures.
  ESM/CJS auth, context and cache state are shared for mixed-module middleware.
- **Route testing:** `express-file-cluster/testing` adds `createTestApp()` using production HTTP
  middleware, routing and error handling without booting services. CommonJS callers delegate to
  the ESM implementation for dynamically imported ESM routes.
- **Database tooling:** bounded opt-in query metrics (`getQueryMetrics` / `resetQueryMetrics`),
  bounded PostgreSQL prepared statements with opt-out and schema-sync invalidation, and a strict
  nightly 10% benchmark regression gate with validated sample allocation and baseline coverage.
- **Upgrade generated apps:** update owned login, refresh, logout, reset-password, change-password and two-factor helper files as
  well as the framework. PostgreSQL preparation defaults to 100 names per connection; disable it
  for incompatible poolers. See the auth, testing, database and logging guides.

## 0.10.1 — 2026-10-30

- **Fix — middleware and catch-all routing:** `compose()` forwards callback errors and Express
  route/router skips without executing later handlers; catch-all parameters decode once and preserve
  encoded slashes and literal percent signs.
- **Generated account security:** password changes verify the current password, persist a new hash,
  clear refresh credentials and revoke existing sessions. Init offers TOTP, email OTP, or both;
  each user/admin enrolls one allowed method. Email choices add SMTP setup. Enrollment, login and
  disable enforce credentials, expiry, rate limits and atomic replay protection. TOTP secrets are
  encrypted with independent `TWO_FACTOR_KEY`; secret/challenge fields are stripped from responses.
  Device-session list/revoke templates explicitly return 501 until implemented.
- **Upgrade generated apps:** review and update auth/account-security templates and model fields,
  configure `TWO_FACTOR_KEY` and SMTP for email OTP, and migrate when auto-sync is disabled. OAuth
  accounts with 2FA enabled use password + code; recovery codes are not implemented. See
  `docs/guides/authentication.md` for the complete flow and upgrade steps.

- **Fix — `efc db pull` no longer writes a second model for a table you already have.** Table names
  drop word breaks (`AuditLog` → `auditlogs`), so a pull named that table's model `Auditlog` and wrote
  `Auditlog.ts` next to your `AuditLog.ts` — on macOS and Windows, where file names ignore case,
  `--force` overwrote `AuditLog.ts` with the pulled schema. Pull now loads the models already in the
  output directory and matches by table / collection: their names are kept (refs from pulled models
  name them too), a model defined in another file is never written again, and a file whose name
  differs from an existing one only in case is never written. Same for `efc import-prisma`'s file
  check. Both engines.

## 0.10.0 — 2026-10-29

**The data layer's remaining Phase 3 work (M5–M7), rate limiting, and working thread tasks.**

- **Fix:** `{ thread: true }` tasks never worked from the published package — `dist/thread-runner.js`
  wasn't built, so every thread task failed with "Cannot find module". It's built now, and
  `enqueue()` inside a thread task works (forwarded to the main thread, which owns the queue).
- **New — typed aggregation pipelines** (`defineCollection`): `Model.pipeline().match().unwind()
  .group().project().count().lookup()…`, each stage's output type inferred. `match`/`sort` cast ids
  like `find()` (raw `aggregate()` never did). **`Model.lookup('ref', Target, filter?)`** replaces a ref
  with its record.
- **New — `efc db pull` for MongoDB:** samples each collection and writes `defineCollection` models —
  BSON types, embedded objects, arrays, required-when-always-present, indexes, and refs found from the
  data. `--sample n`.
- **Changed — new MongoDB apps use `defineCollection`** (`create-efc-app` asks "Models:" for MongoDB
  too; `defineModel` stays available). Existing apps keep their API.
- **New — `efc db studio --write`:** insert, edit and delete rows through your models (validation,
  defaults, timestamps apply); every write needs the studio page's token and origin. Redesigned studio
  UI. Fix: a table dropped while listing no longer empties the table list.
- **New — `rateLimit({ window, max, key? })`** middleware and atomic **`cache.incr()`**: one limit across
  every worker (memory backend) or instance (Redis) — an in-memory counter per worker let N workers
  accept N × max. **`ignite({ trustProxy })`** so `req.ip` is the client behind a load balancer.
- **Changed — generated login and forgot-password routes are rate limited:** 10 attempts / 15 min per
  address + account, 5 reset emails / hour per address. Scaffolded `efc.config` reads `TRUST_PROXY`;
  set it (e.g. `TRUST_PROXY=1`) behind a proxy.
- **New — benchmarks** (`bench/`) against Prisma 7, Drizzle and mongoose, with a nightly regression
  check; results in `bench/README.md`.
- **Docs:** type-inference reference, a feature matrix where every row names the test that proves it,
  and site pages for coming from Prisma / mongoose.

**Upgrading:** `npm i express-file-cluster@^0.10.0`. To rate-limit an existing app's login, add
`export const middlewares = [rateLimit({ window: '15m', max: 10 })]` (or re-add it with
`efc add auth --overwrite`), and set `trustProxy` if you run behind a proxy.

## 0.9.6 — 2026-10-28

**Security release — update your generated auth routes.** Found by an internal review of the framework and
the code `create-efc-app` / `efc add` generate. Upgrading the package does not change files already in your
app; see *Updating an existing app* below. Advisory: GHSA-85c7-prvr-q2rp.

- **Security (critical) — account takeover.** Generated routes passed request values straight into
  filters, and EFC filters accept operator objects. `POST /auth/refresh` with
  `{"refreshToken": {"$ne": null}}` (MongoDB / `defineModel`) or `{"refreshToken": {"not": ""}}`
  (PostgreSQL / `defineTable`) issued a session for another account — any user who had logged in within
  30 days — with no credentials. `POST /auth/reset-password` with an operator as `token` reset the
  password of an account with a pending reset; `GET /auth/verify-email?token[$ne]=x` verified an arbitrary
  pending account. Every generated auth route (login, register, refresh, forgot/reset password, email
  verification, admin user creation, custom-entity `auth:<name>` routes) now answers 400 unless the values
  it looks up by are strings. An e2e test runs these requests against all three stacks.
- **Security (high) — token fields in responses.** `GET /user/profile`, the admin user routes and
  register returned the record minus `password` only. With `authStrategy: 'http-only'`, a script on the page
  (XSS) could read the 30-day refresh token the cookie is meant to protect. `refreshToken`, `resetToken`,
  `verifyToken` and their expiries are stripped now.
- **Security (high) — suspended users kept access.** The role lives in the JWT and `/auth/refresh` didn't
  check `isActive`, so a suspended or demoted user kept their access and could mint new tokens for 30 days.
  Changing a user's role, deactivating or deleting them in the admin routes now ends their sessions
  (`revokeAllSessions`), and `/auth/refresh` refuses inactive accounts (403).
- **Hardening (framework):** `requireAuth` only accepts HS256 tokens (the algorithm EFC signs with);
  errors that carry a 5xx `statusCode` no longer echo their message to clients (4xx still do); a
  `jwtSecret` under 32 bytes logs a warning in production.
- **New:** [`SECURITY.md`](SECURITY.md) (report vulnerabilities privately) and
  [Versioning & support](docs/versioning.md) — what a patch, minor and major may contain, LTS from 1.0,
  supported Node versions (22 and 24). Docs site: *Which model API?*, *Relations*, *Versioning & support*.

**Updating an existing app** (generated before 0.9.6) — do this now, and consider rotating `JWT_SECRET`
(ends every session) and clearing stored `refreshToken` values if the app was exposed: re-add untouched routes with
`efc add auth user-profile account-security forgot-password email-verification admin-users --overwrite`
(only the items you have; reapply your edits to any file you changed; custom entities: `efc add auth:<name>
--overwrite`), or by hand: return 400 unless `typeof value === 'string'` for every `req.body` / `req.query`
value used in a lookup; strip `refreshToken`, `resetToken`, `verifyToken` (and their expiries) from user
objects you return; call `revokeAllSessions(id)` when an admin changes a user's role or deactivates/deletes
them; reject `isActive === false` in `/auth/refresh`.

## 0.9.5 — 2026-10-28

**Database connections: errors that say what to fix, and a warning before the pool runs the server out.**

- **Fix:** connection failures name the fix instead of echoing the driver. A PostgreSQL
  `DATABASE_URL` with no password used to fail with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password
  must be a string`; now: `[EFC] PostgreSQL asked for a password and DATABASE_URL has none (user …).
  Put it in the URL: postgres://user:<password>@host/db`. Also covered: wrong password, missing database
  (`createdb …`), missing role, servers that need `?sslmode=require`, refused/unknown host, timeouts —
  and for MongoDB a rejected login or an unreachable server (Atlas Network Access). pg-boss start-up
  errors go through the same messages. The password is never printed; the driver's error is the
  `cause`.
- **New:** every cluster worker opens its own pool, so at boot one process per machine logs the total
  (`workers × (databasePool.max + pg-boss)`) and, on PostgreSQL, warns when it exceeds the server's
  `max_connections` minus the superuser reserve — before "too many clients" shows up under load.
- **Changed:** `create-efc-app` reminds PostgreSQL users that EFC creates tables, not the database
  or its login (`createdb <name>` locally; the dashboard's connection string for Neon, Supabase, RDS).

## 0.9.4 — 2026-10-28

**Auth strategy: chosen on init, and Bearer apps actually get a token.**

- **Fix:** with the Bearer strategy, the generated login, `/auth/refresh`, custom-entity login
  (`efc add auth:<name>`) and Google/Apple sign-in only ever set a cookie, and `requireAuth` only reads
  the `Authorization` header — so a Bearer app could not log anyone in. `issueToken` now returns the
  token under `'bearer'` (and sets no cookie); the generated routes send `token` (and `refreshToken`)
  in the body. Google/Apple sign-in redirects to `OAUTH_SUCCESS_REDIRECT#code=<code>` — a one-time
  code (60 s, single use) the app posts to the new `/auth/oauth/exchange` for the token, so the JWT never
  appears in a URL. The app starts sign-in with a PKCE `code_challenge` and must send the matching
  `code_verifier`, so another app catching the `myapp://` redirect can't redeem the code. Under `'http-only'` nothing changes: cookie set, `issueToken` resolves `undefined`,
  no token in the body.
- **Changed:** `create-efc-app` asks **Authentication:** up front — `http-only cookie` (browsers:
  websites and SPAs, recommended), `Bearer token` (mobile/desktop apps, API clients) or `None`. Before,
  the question only appeared when an auth feature happened to be ticked, so it was easy to skip.
- **Changed:** `efc add auth` asks the strategy too and writes it to `authStrategy` in `efc.config`
  (before, it always kept `'http-only'`). Without a terminal or with `--no-prompt`, `efc.config` is
  left as it is.
- **New:** `authStrategy: 'bearer'`. `'localStorage'` is the old name and keeps working — it never
  decided where the client stores the token, and a token in browser `localStorage` is readable by any
  script on the page. Any other value still acts as Bearer, as before, but now logs a warning at
  startup (a typo of `'http-only'` used to fail silently); it becomes an error in 1.0.
- **Upgrading a Bearer app:** use the return value — `const token = await issueToken(res, payload);
  res.json({ ...(token ? { token } : {}) })` — or re-add the routes with `efc add auth --overwrite`.
  New apps depend on `express-file-cluster@^0.9.4`.

## 0.9.3 — 2026-10-28

- **Fix:** `efc start prod` now loads `.env` from the working directory when one exists. Variables
  already set in the environment (Docker, Kubernetes, PaaS secrets) still win; the file only fills in
  what's missing. Before, a VPS deploy with just a `.env` booted without `DATABASE_URL`, `JWT_SECRET`, …

## 0.9.2 — 2026-10-28

**Security: zero `npm audit` findings, in the repo and in scaffolded apps.**

- **New:** `hashPassword`, `verifyPassword` and `passwordNeedsRehash` in `express-file-cluster/auth` —
  scrypt from `node:crypto`, no native addon, nothing to install. Hashes store their own cost
  parameters (`scrypt$N$r$p$salt$key`, defaults N=2^15, r=8, p=1).
- **Changed:** `create-efc-app` and `efc add` (auth, admin users, password reset, OAuth, custom
  entities via `efc add auth:<name>`) generate code using these helpers and no longer add `bcrypt` /
  `@types/bcrypt`. `bcrypt` 5 pulled in a vulnerable `tar` through `@mapbox/node-pre-gyp`.
- **Upgrading an existing app:** to drop `bcrypt` too, switch your auth routes to
  `hashPassword`/`verifyPassword` (or re-add them with `efc add auth --overwrite`) and uninstall
  `bcrypt` / `@types/bcrypt`. There is **no bcrypt fallback**: `verifyPassword` returns `false` for old
  `$2b$` hashes (and logs a warning), so existing users reset their password once — the reset stores a
  scrypt hash. New apps depend on `express-file-cluster@^0.9.2`.
- **Scaffolded apps:** the email client now installs `nodemailer@^10.2.1` (was `^6.9.0`, which has
  open advisories; needs Node 20+) with `@types/nodemailer@^8`. TypeScript apps get
  `"overrides": { "esbuild": "^0.28.1" }`, because tsup 8 still asks for an esbuild 0.27 with an advisory.
  Existing apps: bump `nodemailer` and add the same override yourself, then `npm install`.
- **Dependencies:** lockfile refreshed — `zod` 4.6.7, `vitest` 4.1.12, `vite` 8.3, and patched `qs`,
  `body-parser`, `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `source-map-js`.
  `express-file-cluster-mcp` now requires `zod@^4.6.7`.

## 0.9.1 — 2026-10-27

- `defineCollection(name, schema, options)` — a MongoDB-native model with the mongoose vocabulary
  (`find` with projection/sort/populate, `findOneAndUpdate`, `bulkWrite`, `aggregate`, `watch`) and BSON
  types (`decimal128`, `long`, `geoPoint`, `binary`, 2dsphere/text/hashed indexes).
- Custom authenticatable entities: `efc add auth:<name>` (also `--entity <name>`, `auth new <name>`)
  generates a model and `/auth/<name>/register | login | logout | me`.
- Guides: Coming from mongoose; Which model API? covers all three APIs.

## 0.9.0 — 2026-10-23

`efc db generate` writes migrations from model changes. Plus `efc db pull`, `efc import-prisma`, pool
settings (`databasePool`) and a relations guide.

## 0.8.0 — 2026-10-23

`efc add`: auth, portals, billing and more, copied into your app as source you own.

## 0.7.1 — 2026-10-16

The scaffolder generates `defineTable` models with foreign keys on PostgreSQL.

## 0.7.0 — 2026-10-16

Relations for `defineTable`: foreign keys, many-to-many, `include`. Query logging.

## 0.5.0 — 2026-10-15

Types inferred from schemas, `defineTable`, and an MCP server for the docs.

## 0.3 — 2026-07-02

Auth routes and `requireAuth('role')`, typed schema fields, default operators and sequences.

## 0.2 — 2026-06-23

User and admin portals, RBAC, the route docs dashboard and the mailer in the scaffolder.

## 0.1 — 2026-06-22

First release: file-based routing, clustering, background tasks and JWT auth.
