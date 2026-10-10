# EFC — Routing Rules (Exact)

Source: `packages/core/src/router/scan.ts` + `packages/core/src/router/mount.ts`

---

## File → URL transformation (exact algorithm)

```
scan.ts: filePathToUrlPath(relativePath)

1. Strip extension   (.ts | .js | .mts | .mjs | .cts | .cjs)
2. Strip /index      (trailing /index becomes '')
3. Per segment:
     [[...name]] → :name*?   optional catch-all  (≥0 segments)
     [...name]   → :name*    catch-all           (≥1 segment)
     [[name]]    → :name?    optional
     [name]      → :name     dynamic (also inside a segment: post-[id] → post-:id)
4. If result is ''   → '/'
5. Prepend '/'
```

A catch-all must be the LAST segment — `[...slug]/edit.ts` throws at startup. Catch-all
routes mount on a compiled RegExp (`RouteEntry.pattern`); a mapper restores named params,
and catch-all values arrive as `string[]` (URI-decoded; `[]` when an optional one is empty).

### Examples derived from the exact regex

| File (relative to apiDir) | URL |
|---|---|
| `/health.ts` | `/health` |
| `/users/index.ts` | `/users` |
| `/users/[id].ts` | `/users/:id` |
| `/posts/[slug]/comments.ts` | `/posts/:slug/comments` |
| `/index.ts` | `/` |
| `/auth/login.ts` | `/auth/login` |
| `/a/[b]/[c].ts` | `/a/:b/:c` |
| `/users/[[id]].ts` | `/users/:id?` (matches `/users` and `/users/7`) |
| `/docs/[...slug].ts` | `/docs/:slug*` (`/docs/a/b` → `slug: ['a','b']`; not `/docs`) |
| `/docs/[[...slug]].ts` | `/docs/:slug*?` (also `/docs` → `slug: []`) |

**Edge case:** `/users/index.ts` → strips extension → `/users/index` → strips `/index` → `/users`. NOT `/users/`. There is no trailing slash.

---

## Sorting: per-segment specificity

Each segment gets a rank — static 0, `[id]` 1, `[[id]]` 2, `[...slug]` 3, `[[...slug]]` 4 — and
routes are compared rank-by-rank from the first segment; ties sort alphabetically by URL.
So `/users/me` beats `/users/:id`, which beats `/users/:id?`, then `/users/:rest*`.

---

## Method dispatching (mount.ts)

Recognised method names (exact — case-sensitive uppercase):
```
GET  POST  PUT  PATCH  DELETE  HEAD  OPTIONS
```

For each route module:
1. Import the module dynamically.
2. Read `mod.middlewares` (must be an array, else ignored), `mod.schema`, `mod.meta`.
3. For each of the 7 method names, check `typeof mod[METHOD] === 'function'`.
4. Register: `app[method](pattern ?? urlPath, ...paramMapper?, ...middlewares, validate?, asyncWrap(handler))`.
   `validate` exists when `schema` has an entry for that method (method key wins over file-wide
   `{ params, query, body }`). It runs AFTER middlewares; failure → 400 with `issues`.
5. If **any** methods are implemented and **any** are unimplemented: register `app.all(urlPath, ...)` that returns 405 with `Allow: <implemented>` for the missing methods.

**asyncWrap**: `Promise.resolve(handler(req, res, next)).catch(next)` — all route errors auto-forwarded.

---

## `middlewares` export rules

```ts
export const middlewares = [mw1, mw2]; // ✅ valid — applied to all methods
export const middlewares = mw1;         // ❌ ignored — must be an array
```

The check in mount.ts: `Array.isArray(mod['middlewares'])`.

---

## Route file extensions accepted

```
.ts  .js  .mts  .mjs  .cts  .cjs
```

Regex: `/\.(ts|js|mts|mjs|cts|cjs)$/`

Files that do NOT match this pattern are silently ignored by `scanDir`.

---

## What scanDir does NOT do

- Does NOT follow symlinks (uses `fs.readdirSync` with `withFileTypes`).
- Does NOT skip files named `index.ts` specially during scan — they are treated as routes whose URL resolves to the parent directory path.
- Does NOT support nested `index` files as catch-alls — only the exact directory name maps to the URL.
- Does NOT allow a catch-all anywhere but the last segment.

---

## 405 response format

```json
{ "error": "Method Not Allowed" }
```

Header: `Allow: GET, POST` (only the implemented methods).

**Only sent when at least one method IS implemented.** A file that exports no HTTP methods gets no 405 handler — Express would return 404.
