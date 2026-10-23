# Middleware

EFC supports three tiers of middleware. Each tier has a distinct scope — pick the right tier and you never apply middleware more broadly than you intend.

---

## Tier 1 — Global middleware

Configured in `ignite()`. Applied to **every** incoming request, before any route is matched.

```ts
import rateLimit from 'express-rate-limit';

ignite({
  globalMiddlewares: [
    rateLimit({ windowMs: 60_000, max: 100 }),
  ],
});
```

> **CORS is built-in.** EFC applies its own CORS middleware based on the `cors` option in `ignite()` (see [`ignite()` reference](../api-reference/ignite.md#cors)). You do not need to pass a `cors()` call here — doing so would create a duplicate header.

---

## Tier 2 — Route-level middleware

Export a `middlewares` array from a route file. Applied to every handler exported from that file, after global middleware.

```ts
// src/api/admin/users.ts
import { requireAuth } from 'express-file-cluster/auth';
import { authorize } from '../../middlewares/authorize';

export const middlewares = [requireAuth, authorize('admin')];

export const GET = async (req, res) => {
  // Only reachable after requireAuth + authorize('admin') pass
  res.json({ users: [] });
};

export const DELETE = async (req, res) => {
  // Same guard applies here automatically
  res.status(204).send();
};
```

---

## Tier 3 — Handler-level middleware (`compose`)

`compose(...handlers)` wraps a single handler with one or more middleware functions. Use it for guards that apply to exactly one method in a file.

```ts
// src/api/users/index.ts
import { compose } from 'express-file-cluster';
import { validateBody } from '../../middlewares/validation';
import { CreateUserSchema } from '../../schemas/user';

export const GET = async (req, res) => {
  res.json({ users: [] });
};

// Only POST gets body validation
export const POST = compose(
  validateBody(CreateUserSchema),
  async (req, res) => {
    // req.body is guaranteed valid here
    res.status(201).json({ id: 'new-id' });
  },
);
```

---

## How `compose` works

`compose(...handlers)` in `packages/core/src/compose.ts` returns a single `RequestHandler` that chains the provided handlers in sequence. Each handler calls `next()` to advance to the next one. If any handler throws or rejects, the error is forwarded to Express's error chain via `next(err)`.

```ts
export function compose(...handlers: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    let index = 0;

    function dispatch(i: number): void {
      if (i >= handlers.length) { next(); return; }
      const handler = handlers[i];
      try {
        Promise.resolve(handler(req, res, () => dispatch(i + 1))).catch(next);
      } catch (err) {
        next(err);
      }
    }

    dispatch(index);
  };
}
```

---

## Middleware execution order

For a request that hits `POST /users` on a file that has both `export const middlewares` and a `compose` handler:

```
global middlewares (ignite)
       ↓
route-level middlewares (export const middlewares = [...])
       ↓
handler-level middlewares (compose(mw1, mw2, handler))
       ↓
the actual handler function
```

---

## Writing a middleware

EFC middleware is a plain Express `RequestHandler`:

```ts
// src/middlewares/authorize.ts
import type { Request, Response, NextFunction } from 'express';

export function authorize(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (user?.role !== role) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
```

Scaffold a middleware file with the CLI:

```bash
efc generate middleware authorize
# → src/middlewares/authorize.ts
```

> Route-level role protection doesn't need a custom middleware like `authorize` above — `requireAuth` itself accepts role names: `requireAuth('admin')`. The routes `efc add` generates use this shorthand, and `efc add admin-admins` adds a `Role` model. See [RBAC](../guides/rbac.md).
