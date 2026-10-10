# Request Validation

Route files can export a `schema` that validates `params`, `query` and `body` before the handler runs. Invalid requests never reach your code; valid ones arrive already parsed.

---

## Any validator, no lock-in

EFC accepts any [Standard Schema](https://standardschema.dev) validator — zod 3.24+, valibot, arktype, effect/schema — plus anything exposing a zod-style `safeParse`. It never imports a validation library, so install the one you like:

```bash
npm install zod
```

---

## Per method, or for the whole file

```ts
// src/api/products/[id].ts
import { z } from 'zod';

export const schema = {
  GET: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ include: z.enum(['reviews', 'stock']).optional() }),
  },
  PATCH: {
    params: z.object({ id: z.string().uuid() }),
    body: z.object({ price: z.number().positive(), title: z.string().min(2) }).partial(),
  },
};

export const GET = async (req, res) => { /* ... */ };
export const PATCH = async (req, res) => { /* ... */ };
```

When every method shares the same rules, skip the method keys:

```ts
export const schema = { params: z.object({ id: z.coerce.number().int() }) };
```

A method-keyed entry wins over the file-wide one; methods with no entry are not validated.

---

## Parsed output replaces the raw input

On success, `req.params`, `req.query` and `req.body` are replaced by the validator's **output** — coercions (`z.coerce.number()`), defaults (`.default('member')`) and transforms apply:

```ts
export const schema = { POST: { body: z.object({ age: z.coerce.number(), role: z.string().default('member') }) } };

export const POST = async (req, res) => {
  req.body; // { age: 21, role: 'member' } for an input of { age: '21' }
};
```

---

## Error response

All issues from every location are returned together with status **400**:

```json
{
  "error": "Validation failed",
  "statusCode": 400,
  "issues": [
    { "location": "body", "path": "email", "message": "Invalid email address" },
    { "location": "query", "path": "page", "message": "Expected number, received nan" }
  ]
}
```

`path` is dot-joined inside its location (`address.zip`), empty for the root.

---

## Ordering

The request pipeline for a route is:

```
global middleware → file middlewares → schema validation → handler
```

So authentication in `middlewares` still responds 401/403 before any 400 — unauthenticated callers can't probe your validation rules.

---

## Model-level validation is separate

`schema` validates the HTTP request. `defineModel` validates what you write to the database (types, `required`, `enum`, `min`/`max`, `match`, custom `validate`) and throws a `ModelValidationError` — also a 400 with `issues`. Use both: request schemas for the API contract, model rules for data integrity. See [Database](./database.md).
