# Caching & Sessions

`ignite({ cache })` gives you a key/value cache, response caching for GET routes, and the store `requireAuth` checks for **revoked sessions** — so logging out (or "log out everywhere") actually invalidates tokens.

---

## Configure

```ts
// efc.config.ts
const config: EFCConfig = {
  cache: { backend: 'redis', url: process.env.REDIS_URL },
};
```

| Option | Backend | Default | |
|---|---|---|---|
| `backend` | — | — | `'redis'` (shared by all workers and instances) or `'memory'` (per process) |
| `url` | redis | `redis://localhost:6379` | `rediss://`, ACL users and `/db` supported |
| `prefix` | both | `'efc:'` | Key prefix, so several apps can share one Redis |
| `timeout` | redis | `1000` | Per-command ms before Redis counts as unavailable |
| `maxEntries` | memory | `10000` | Least-recently-used entries are evicted beyond this |

Requires `ioredis` for the Redis backend (`npm install ioredis` — BullMQ already depends on it). The **memory** backend is for development and tests: each cluster worker gets its own copy, so cached entries and revoked sessions aren't shared — `ignite()` logs a warning when you combine it with clustering.

---

## The `cache` API

```ts
import { cache } from 'express-file-cluster';

await cache.set('user:42', user, { ttl: 300 });      // seconds; omit for no expiry
const hit = await cache.get<User>('user:42');        // undefined on a miss
await cache.has('user:42');
await cache.del('user:42', 'user:43');               // → number deleted
await cache.clear('user:');                          // every key with this prefix → number deleted

// Get-or-compute: concurrent callers in one process share a single computation
const stats = await cache.wrap('stats:daily', 60, () => Stats.aggregate(pipeline));
```

Values are stored as JSON — `Date`s come back as ISO strings. `undefined` is never cached.

### When Redis is down

The cache **degrades instead of failing**: `get` returns `undefined`, `set`/`del` are no-ops, `wrap` just runs your function. Requests keep working (only slower), and a warning is logged at most every 30 seconds. Boot waits up to ~2 s for the first connection, then continues regardless.

---

## Response caching

```ts
// src/api/products/index.ts
import { cacheResponse } from 'express-file-cluster';

export const middlewares = [cacheResponse(60)];   // seconds

export const GET = async (req, res) => {
  res.json(await Product.find({}, { sort: { name: 1 } }));
};
```

- Caches **200 JSON** responses of `GET`/`HEAD`; other methods and statuses pass through.
- Keyed by the full URL (path + query) — `?page=2` is a separate entry. Override with `key: (req) => …`.
- Adds `X-Cache: HIT` or `MISS`.
- Per-user data: put `requireAuth` first and use `perUser: true` — entries are keyed by the JWT's `sub`/`id`, and requests without a user skip the cache instead of sharing one.

```ts
export const middlewares = [requireAuth, cacheResponse({ ttl: 30, perUser: true })];
```

Invalidate after writes by prefix — cached responses live under `res:`:

```ts
export const POST = async (req, res) => {
  const product = await Product.create(req.body);
  await cache.clear('res:/v1/api/products');
  res.status(201).json(product);
};
```

---

## Session revocation

JWTs are stateless, so on their own a token stays valid until it expires — clearing the cookie doesn't help if the token was copied. With a cache configured, every token EFC signs carries a unique `jti`, and `requireAuth` checks a denylist:

```ts
import { requireAuth, revokeSession, revokeAllSessions } from 'express-file-cluster/auth';

// Log out this device: the current token is rejected from now until it would have expired.
export const middlewares = [requireAuth];
export const POST = async (req, res) => {
  await revokeSession(req, res);   // `res` also clears the cookie (http-only strategy)
  res.json({ ok: true });
};

// Log out everywhere / after a password change: every token issued to this user
// before now is rejected; tokens issued afterwards work.
await revokeAllSessions(user.id);  // the JWT's `sub` or `id` claim
```

Entries expire on their own once the tokens they cover would have expired (`jwtExpiresIn`), so the denylist never grows unbounded.

**Outage behaviour.** If the cache is unreachable while `requireAuth` checks a token, the request is **allowed** and an error is logged — an outage shouldn't log every user out. Revocations made before the outage apply again once the cache is back. Calling `revokeSession` / `revokeAllSessions` during an outage **throws**, so a failed logout is never reported as a success.

`revokeToken(res)` still exists and only clears the cookie — prefer `revokeSession` when a cache is configured.
