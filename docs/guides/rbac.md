# Role-Based Access Control (RBAC)

Role checks are built into `requireAuth` itself — call it with role names (`requireAuth('admin')`) instead of a separate middleware (see [Authentication](./authentication.md)). The routes the registry generates use it throughout, and the `admin-admins` item adds a `Role` model and a role-management API.

---

## What gets generated

### Route protection

Every protected route that [`efc add`](../cli/add.md) or `create-efc-app` generates checks roles with `requireAuth(...)`:

```ts
// User-facing routes
export const middlewares = [requireAuth('user', 'admin')];

// Admin-facing routes
export const middlewares = [requireAuth('admin')];
```

`requireAuth('admin')` verifies the JWT *and* checks that `payload.role` is one of the given roles. It returns `401` if the token is missing or invalid, and `403` if the role doesn't match.

### `Role` model and role management

`efc add admin-admins` creates `src/model/Role.ts` (`defineModel` on MongoDB, `defineTable` on PostgreSQL by default) and a role-management API:

| Method | Path |
|---|---|
| `GET` | `/admin/roles` |
| `POST` | `/admin/roles` |
| `GET` | `/admin/roles/:id` |
| `PUT` | `/admin/roles/:id` |
| `DELETE` | `/admin/roles/:id` |

See [Generated Portals](./generated-portals.md) for the complete route/model inventory.

---

## Using it yourself

You don't need the scaffolder to use this pattern — `requireAuth(...roles)` is exported from `express-file-cluster/auth` in every EFC project:

```ts
// src/api/admin/dashboard.ts
import { requireAuth } from 'express-file-cluster/auth';

export const middlewares = [requireAuth('admin')];

export const GET = async (_req, res) => {
  res.json({ stats: { users: 42 } });
};
```

Pass multiple roles to allow any of them: `requireAuth('user', 'admin')`. See the [Auth API reference](../api-reference/auth.md#requireauth) for the full signature.
