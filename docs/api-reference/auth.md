# Auth — API Reference

EFC ships a JWT-based authentication module with two delivery strategies. All functions are exported from `express-file-cluster/auth`.

```ts
import {
  issueToken,
  revokeToken,
  revokeSession,
  revokeAllSessions,
  signToken,
  requireAuth,
  getCurrentUser,
} from 'express-file-cluster/auth';
```

Auth must be configured before any of these functions are called. Configuration happens automatically inside `ignite()` when `jwtSecret` is provided.

---

## `issueToken(res, payload)`

Signs a JWT and sets it as an `HttpOnly` cookie on the response. Use with the `'http-only'` auth strategy.

```ts
async function issueToken(
  res: Response,
  payload: Record<string, unknown>,
): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `res` | `Response` | Express response object |
| `payload` | `Record<string, unknown>` | JWT claims (e.g. `{ sub: user.id, role: user.role }`) |

The cookie is named `efc_token` and is set with:

- `HttpOnly: true` — not accessible via `document.cookie`
- `Secure: true` — only sent over HTTPS (when `NODE_ENV === 'production'`)
- `SameSite: Strict` — only sent on same-site requests
- `Domain: COOKIE_DOMAIN` — set when the `COOKIE_DOMAIN` env var is configured

**Example:**

```ts
// src/api/auth/login.ts
import { issueToken } from 'express-file-cluster/auth';

export const POST = async (req, res) => {
  const user = await verifyCredentials(req.body.email, req.body.password);
  await issueToken(res, { sub: user.id, role: user.role });
  res.json({ message: 'Logged in' });
};
```

---

## `revokeToken(res)`

Clears the `efc_token` cookie. Use with the `'http-only'` strategy.

```ts
function revokeToken(res: Response): void
```

**Example:**

```ts
// src/api/auth/logout.ts
import { revokeToken } from 'express-file-cluster/auth';

export const POST = async (req, res) => {
  revokeToken(res);
  res.json({ message: 'Logged out' });
};
```

This only removes the cookie — a copy of the token stays valid until it expires. To actually invalidate it, configure a `cache` and use `revokeSession`.

---

## `revokeSession(req, res?)`

```ts
async function revokeSession(req: Request, res?: Response): Promise<void>
```

Rejects the token the request was authenticated with — `requireAuth` answers 401 for it from now until it would have expired. Passing `res` also clears the cookie (http-only strategy). Requires `cache` in `ignite()`; throws if the cache is unreachable.

## `revokeAllSessions(userId)`

```ts
async function revokeAllSessions(userId: string | number): Promise<void>
```

Rejects every token issued to that user (`sub` or `id` claim) before now — "log out everywhere" or after a password change. Tokens issued afterwards are unaffected. Requires `cache`.

Every token EFC signs carries a `jti` and an issue time, which these checks use. See [Caching & Sessions](../guides/caching.md#session-revocation) for the outage behaviour.

---

## `signToken(payload)`

Signs a JWT and returns the token string. Use with the `'localStorage'` strategy; the client stores the token and attaches it as `Authorization: Bearer <token>`.

```ts
async function signToken(
  payload: Record<string, unknown>,
): Promise<string>
```

**Example:**

```ts
// src/api/auth/login.ts
import { signToken } from 'express-file-cluster/auth';

export const POST = async (req, res) => {
  const user = await verifyCredentials(req.body.email, req.body.password);
  const token = await signToken({ sub: user.id, role: user.role });
  res.json({ token });
};
```

The client then stores the token (e.g. `localStorage.setItem('token', token)`) and sends it on subsequent requests:

```http
Authorization: Bearer <token>
```

---

## `requireAuth`

Express middleware that verifies the JWT and attaches the decoded payload to `req.user`. Returns `401 Unauthorized` if the token is missing, expired, or invalid.

Used bare, it only checks that the token is valid. Called with one or more role names, it returns a middleware that *also* enforces `payload.role` is one of them — returning `403 Forbidden` otherwise.

```ts
interface RequireAuth {
  (req: Request, res: Response, next: NextFunction): void; // bare — auth only
  (...roles: string[]): RequestHandler;                    // requireAuth('admin') — auth + role check
}
const requireAuth: RequireAuth
```

Behaviour depends on the configured `authStrategy`:

| Strategy | Token source |
|---|---|
| `'http-only'` | `req.cookies.efc_token` |
| `'localStorage'` | `Authorization: Bearer <token>` header |

**Route-level, auth only (protects all handlers in the file):**

```ts
// src/api/users/index.ts
import { requireAuth } from 'express-file-cluster/auth';

export const middlewares = [requireAuth];

export const GET = async (req, res) => {
  // req.user is populated here
  res.json({ userId: (req as any).user.sub });
};
```

**Route-level, auth + role:**

```ts
// src/api/admin/users.ts
import { requireAuth } from 'express-file-cluster/auth';

export const middlewares = [requireAuth('admin')];

export const GET = async (req, res) => {
  // only reachable when payload.role === 'admin'
  res.json({ users: [] });
};
```

Pass multiple roles to allow any of them: `requireAuth('user', 'admin')`.

**Handler-level (protects one method):**

```ts
import { compose } from 'express-file-cluster';
import { requireAuth } from 'express-file-cluster/auth';

export const DELETE = compose(requireAuth('admin'), async (req, res) => {
  // only DELETE requires auth + the admin role
  res.status(204).send();
});
```

---

## `getCurrentUser()`

Reads the JWT payload `requireAuth` attached to the in-flight request, from anywhere in the async call chain — not just where `req` is in scope. Backed by `AsyncLocalStorage`; every request run through `ignite()` gets its own isolated context.

```ts
function getCurrentUser(): Record<string, unknown> | undefined
```

Returns `undefined` outside a request, or on a request that never ran through `requireAuth` (e.g. a public route).

```ts
import { getCurrentUser } from 'express-file-cluster/auth';

export const GET = async (req, res) => {
  const user = getCurrentUser(); // same payload as req.user here, but callable from deeper code paths
  res.json({ userId: user?.['sub'] });
};
```

This is also what powers the `'$currentUser'` / `'$currentUser.<key>'` `defineModel` default operator codes — see the [`db` API reference](./db.md#default-value-operator-codes) — so a `createdBy` field can be populated automatically on `.create()` without threading `req.user` through every route handler.

---

## Token lifetime

Controlled by the `JWT_EXPIRES_IN` environment variable. Default: `7d`.

Accepts any value the [`jose`](https://github.com/panva/jose) library supports: `15m`, `1h`, `7d`, `30d`, etc.

---

## Algorithm

Tokens are signed with **HS256** (HMAC-SHA256). The secret is UTF-8 encoded before signing. Asymmetric algorithms (RS256, ES256) are not currently supported.
