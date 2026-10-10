# EFC — Auth Internals (Exact)

Source: `packages/core/src/auth/index.ts`

---

## Configuration (happens in Pre-Flight)

```ts
// Called by ignite() at Pre-Flight step 2
configureAuth({
  secret: jwtSecret,
  strategy: authStrategy,          // 'http-only' | 'localStorage'
  expiresIn: JWT_EXPIRES_IN ?? '7d',
  cookieDomain: COOKIE_DOMAIN,     // optional
})
```

`_config` is a module-level singleton. All auth functions throw `'[EFC] Auth not configured — pass jwtSecret to ignite()'` if called before `configureAuth`.

---

## `issueToken(res, payload)`

```ts
// Signs JWT (HS256), sets HttpOnly cookie
const token = await new SignJWT(payload)
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime(expiresIn)
  .sign(new TextEncoder().encode(secret))

res.cookie('efc_token', token, {
  httpOnly: true,
  secure: process.env['NODE_ENV'] === 'production',
  sameSite: 'strict',
  ...(cookieDomain && { domain: cookieDomain }),
})
```

Cookie name: exactly `'efc_token'` (hardcoded).
`secure` is only set in production. In dev, the cookie is sent over HTTP.
**Does NOT set `path` explicitly** — defaults to `/`.
**Does NOT set `maxAge` or `expires`** — cookie is session-scoped (expires when browser closes), but the JWT itself has an expiry enforced server-side by `jwtVerify`.

---

## `revokeToken(res)`

```ts
res.clearCookie('efc_token')
```

That's the entire implementation. Clears the cookie. The JWT itself is not invalidated — use `revokeSession` for that.

---

## Session revocation (`revokeSession`, `revokeAllSessions`) — needs `cache`

Every signed token now carries `jti` (randomUUID), `iat`, and `efc_iat` (ms) — via the shared `sign()` used by
both `issueToken` and `signToken`.

- `revokeSession(req, res?)`: verifies the request's token, sets cache key `sess:jti:<jti>` with TTL = `exp - now`;
  clears the cookie when `res` is given and strategy is http-only. Throws if no cache / cache unreachable.
- `revokeAllSessions(userId)`: sets `sess:user:<id>` = `Date.now()` with TTL = `jwtExpiresIn` in seconds.
- `requireAuth` (only when a cache is configured): after `jwtVerify`, rejects with 401 if `sess:jti:<jti>` exists,
  or if `efc_iat` (fallback `iat*1000`) < the user's cutoff. User id = `payload.sub ?? payload.id`.
  If the cache read throws → `cache.onRevocationCheckError`: `'reject'` (default) → **503**
  `{ error: 'Service Unavailable', statusCode: 503 }`; `'allow'` → request passes. Logged at most every 30 s.

---

## `signToken(payload)`

```ts
// Signs JWT, returns string (no cookie)
return await new SignJWT(payload)
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime(expiresIn)
  .sign(new TextEncoder().encode(secret))
```

No `res` argument. Token must be sent in the response body by the route handler.

---

## `requireAuth` — middleware internals

`requireAuth` is dual-purpose, dispatched at runtime on the first argument:

```ts
// Bare — Express calls it as (req, res, next). First arg is an object → auth-only path.
export const middlewares = [requireAuth];

// Role-checked — called by user code with string args first, returns a new
// RequestHandler that Express later invokes as (req, res, next).
export const middlewares = [requireAuth('admin')];          // any of these roles
export const middlewares = [requireAuth('user', 'admin')];  // multiple allowed
```

```ts
// Strategy 'http-only': reads req.cookies.efc_token
// Strategy 'localStorage': reads Authorization header → strips 'Bearer '

if (!token) → res.status(401).json({ error: 'Unauthorized' }); return

const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))

// only when called with role names:
if (roles.length > 0 && !roles.includes(payload.role)) →
  res.status(403).json({ error: 'Forbidden' }); return

(req as any).user = payload   // ← attaches to req.user
next()
```

On any auth error (expired, invalid signature, malformed, missing token): catches and returns `{ error: 'Unauthorized' }` with status 401. A role mismatch returns `{ error: 'Forbidden' }` with status 403 instead. **Does NOT call next(err)** in either case — it handles the response itself and returns.

`req.user` is typed as `unknown` in the source. Cast to your payload type or use `(req as any).user`.

---

## JWT library

Uses `jose` (not `jsonwebtoken`). Key is UTF-8 encoded via `new TextEncoder().encode(secret)` before every call — no pre-computed key object is cached between requests.

---

## Token expiry

`expiresIn` is passed into `configureAuth` as a plain string by `ignite()` (`config.jwtExpiresIn ?? '7d'`) — `configureAuth` itself never touches `process.env`. All tokens issued in the same process lifetime use the same expiry value.

Format accepted by `jose`: `'15m'`, `'1h'`, `'7d'`, `'30d'`, integer seconds, etc.

---

## What auth does NOT do

- No refresh tokens in the framework itself (the scaffolder can generate an app-level `/auth/refresh` route backed by a DB-stored token — that's app code, not a core export).
- No revocation without a `cache` configured (then `revokeToken` just clears the cookie and a copied token stays valid until it expires). With a cache: `revokeSession` / `revokeAllSessions`.
- No CSRF token — relies on `SameSite: Strict` for http-only strategy.
- No multi-strategy per-route override — `authStrategy` is global, set once in `ignite()`.
