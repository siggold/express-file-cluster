# `efc generate`

Scaffold boilerplate files without hand-writing them. All generators write TypeScript files and refuse to overwrite existing files.

The command also accepts the alias `efc g`.

---

## `efc generate route <routePath>`

Creates a route module at `src/api/<routePath>.ts`.

```bash
efc generate route users
efc generate route users/[id]
efc generate route posts/[slug]/comments
```

The generated file exports `GET` and `POST` stubs:

```ts
// src/api/users/[id].ts  (after: efc generate route users/[id])
import type { Request, Response } from 'express';

export const GET = async (req: Request, res: Response) => {
  res.json({ message: 'OK' });
};

export const POST = async (req: Request, res: Response) => {
  res.status(201).json({ message: 'Created' });
};
```

The path argument is relative to `src/api/`. Parent directories are created automatically.

| Command | Output file | Route URL |
|---|---|---|
| `efc generate route health` | `src/api/health.ts` | `/health` |
| `efc generate route users/[id]` | `src/api/users/[id].ts` | `/users/:id` |
| `efc generate route posts/[slug]/comments` | `src/api/posts/[slug]/comments.ts` | `/posts/:slug/comments` |

---

## `efc generate task <name>`

Creates a task module at `src/tasks/<name>.ts`.

```bash
efc generate task SendEmail
efc generate task ResizeImage
efc generate task ProcessPayment
```

The generated file exports a typed `defineTask` skeleton:

```ts
// src/tasks/SendEmail.ts  (after: efc generate task SendEmail)
import { defineTask } from 'express-file-cluster/tasks';

interface SendEmailPayload {
  // TODO: define payload fields
}

export default defineTask<SendEmailPayload>(async (payload) => {
  // TODO: implement task logic
  console.log('[Task:SendEmail]', payload);
});
```

The task is registered automatically when the app starts — no extra wiring required.

---

## `efc generate middleware <name>`

Creates a middleware module at `src/middlewares/<name>.ts`.

```bash
efc generate middleware authorize
efc generate middleware validateBody
efc generate middleware requestLogger
```

The generated file exports a plain Express `RequestHandler`:

```ts
// src/middlewares/authorize.ts  (after: efc generate middleware authorize)
import type { Request, Response, NextFunction } from 'express';

export function authorize(req: Request, res: Response, next: NextFunction): void {
  // TODO: implement middleware logic
  next();
}
```

---

## `efc generate migration <name>`

Creates `src/migrations/<UTC timestamp>_<snake_name>.ts` (`.js` without a `tsconfig.json`) with `up` / `down` stubs. Run it with `efc db migrate`. See [Migrations & Seeds](../guides/migrations.md).

```bash
efc generate migration AddOrders   # → src/migrations/20261010120000_add_orders.ts
```

---

## `efc generate seed <name>`

Creates `src/seeds/<snake_name>.ts` exporting a default seed function. Run it with `efc db seed` or `efc db seed <snake_name>`.

---

## Error: file already exists

If the target file already exists, the generator prints an error and exits with code 1 — it never overwrites existing files:

```
File already exists: src/api/users/[id].ts
```
