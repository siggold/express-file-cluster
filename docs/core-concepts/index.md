# Core Concepts

EFC is built around four interlocking ideas. Understanding each one independently makes the whole system easy to reason about.

---

## 1. File-Based Routing

The directory tree under `src/api/` **is** the route tree. No `router.get(...)` registration, no explicit path strings — the file path is the URL path.

```
src/api/users/[id].ts   →   GET /users/:id
```

Each route file exports uppercase HTTP method names as async functions. Methods not exported return **405 Method Not Allowed** automatically.

→ [File-Based Routing](./file-based-routing.md)

---

## 2. Multi-Core Clustering

With `cluster: true`, EFC forks `os.cpus().length` identical worker processes. Each worker runs the full **Pre-Flight lifecycle** independently (connect DB → configure auth → scan routes → register tasks → listen).

The OS round-robins incoming connections across workers. If a worker crashes, the master immediately forks a replacement.

→ [Clustering](./clustering.md)

---

## 3. Background Tasks

The `src/tasks/` directory holds background jobs — work that should happen *off* the request/response cycle. Define a task with `defineTask()`, trigger it from any route handler with `enqueue()`, and the queue backend — **BullMQ** (Redis) or **pg-boss** (PostgreSQL) — handles retries, backoff, cron schedules, dead letters and concurrency.

CPU-bound tasks can opt into `worker_threads` execution with `{ thread: true }`, keeping the event loop free.

→ [Background Tasks](./background-tasks.md)

---

## 4. Middleware System

EFC supports three tiers of middleware with clear, non-overlapping scopes:

- **Global** — configured in `ignite()`, applied to every request.
- **Route-level** — `export const middlewares = [...]` in a route file, applied only to handlers in that file.
- **Handler-level** — `compose(mw1, mw2, handler)`, applied to a single handler.

→ [Middleware](./middleware.md)

---

## How the pieces fit together

```
HTTP Request
     │
     ▼
Global Middleware (ignite({ globalMiddlewares }))
     │
     ▼
Route-Level Middleware (export const middlewares = [...])
     │
     ▼
Handler-Level Middleware (compose(...))
     │
     ▼
Route Handler (export const GET = ...)
     │
     ├── sync response  → res.json(...)
     │
     └── heavy work     → enqueue('TaskName', payload)
                               │
                               ▼
                         Queue Backend (BullMQ / pg-boss)
                               │
                               ├── I/O-bound  → event loop
                               └── CPU-bound  → worker_threads
```
