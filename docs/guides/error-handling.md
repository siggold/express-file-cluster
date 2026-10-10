# Error Handling Guide

EFC provides a structured error model that converts exceptions into clean HTTP responses without try/catch in every handler.

---

## How it works

Every route handler is wrapped in `asyncWrap`, which passes any thrown error or rejected promise to Express's `next(err)`. The global error handler at the bottom of the middleware stack then inspects the error and responds.

```
throw new HttpError(404, 'Not found')
         ↓
asyncWrap catches it → next(err)
         ↓
EFC global error handler
         ↓
HTTP 404  { "error": "Not found", "statusCode": 404 }
```

---

## `HttpError`

Throw `HttpError` to signal a specific HTTP status:

```ts
import { HttpError } from 'express-file-cluster';

export const GET = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
};
```

The default response shape:

```json
{
  "error": "User not found",
  "statusCode": 404
}
```

See the full [`HttpError` reference](../api-reference/http-error.md).

---

## Unhandled errors

Any `throw` that is not an `HttpError` (e.g. a database error, a null pointer, an unexpected exception) is treated as a server error:

```json
{
  "error": "Internal Server Error",
  "statusCode": 500
}
```

The original error is logged at `error` level with the request ID and stack (see [Logging](./logging.md)):

```
12:00:01 ERROR [w1] 3f9c2a1b Unhandled error
TypeError: Cannot read properties of null
    at GET (src/api/users/[id].ts:8:21)
```

---

## Validation and database errors

These arrive as `HttpError` subclasses, so they need no handling in route code:

| Source | Status | Body |
|---|---|---|
| Route `schema` rejects the request | `400` | `{ "error": "Validation failed", "statusCode": 400, "issues": [{ "location", "path", "message" }] }` |
| `defineModel` write fails validation (`ModelValidationError`) | `400` | `{ "error": "User validation failed: email: is required", "statusCode": 400, "issues": [{ "path", "message" }] }` |
| Duplicate value of a `unique` field | `409` | `{ "error": "User with this email already exists", "statusCode": 409 }` |

Catch `ModelValidationError` only when you want to react differently:

```ts
import { ModelValidationError } from 'express-file-cluster';

try {
  await User.create(req.body);
} catch (err) {
  if (err instanceof ModelValidationError && err.issues.some((i) => i.path === 'email')) {
    throw new HttpError(422, 'Please provide a valid email');
  }
  throw err;
}
```

---

## Custom global error handler

Override the built-in handler with `onError` in `ignite()`:

```ts
import { HttpError } from 'express-file-cluster';
import type { ErrorRequestHandler } from 'express';

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status = err instanceof HttpError ? err.statusCode : 500;
  const message = err instanceof HttpError ? err.message : 'Internal Server Error';

  logger.error({ err, url: req.url, method: req.method });

  res.status(status).json({
    error: message,
    path: req.path,
    requestId: req.headers['x-request-id'],
  });
};

ignite({ onError: errorHandler });
```

---

## Errors in middleware

Middleware errors are forwarded the same way — call `next(err)` or `throw` from an async middleware and the global handler picks it up:

```ts
// src/middlewares/validate.ts
import type { RequestHandler } from 'express';
import { HttpError } from 'express-file-cluster';
import { z } from 'zod';

export function validateBody(schema: z.ZodType): RequestHandler {
  return async (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new HttpError(422, result.error.message));
    }
    req.body = result.data;
    next();
  };
}
```

---

## Errors in tasks

Task errors do not crash the application. The backend (BullMQ or pg-boss) catches failed jobs, retries them according to `retries` and `backoff`, and dead-letters them after the last attempt. Each failure is logged with the task, job ID and attempt:

```
12:00:01 ERROR [w2] Task SendEmail failed task=SendEmail jobId=1842 attempt=2
Error: SMTP connection refused
```

Inspect, retry or purge dead-lettered jobs with `efc tasks failed | retry | purge` — see [Background Tasks › Dead letters](../core-concepts/background-tasks.md#dead-letters).

---

## Error response reference

| Scenario | Status | Body |
|---|---|---|
| `throw new HttpError(N, msg)` | `N` | `{ "error": msg, "statusCode": N }` |
| Any other thrown error | `500` | `{ "error": "Internal Server Error", "statusCode": 500 }` |
| Method not implemented | `405` | `{ "error": "Method Not Allowed" }` + `Allow` header |
| Route `schema` validation failed | `400` | `{ "error": "Validation failed", "statusCode": 400, "issues": [...] }` |
| Model validation failed | `400` | `{ "error": "...", "statusCode": 400, "issues": [...] }` |
| Unique constraint violated | `409` | `{ "error": "<Model> with this <field> already exists", "statusCode": 409 }` |
| `requestTimeout` exceeded | `408` | `{ "error": "Request Timeout", "statusCode": 408 }` |
| Missing/invalid auth token | `401` | `{ "error": "Unauthorized" }` |
