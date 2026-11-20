---
name: efc
description: Ground-truth reference for express-file-cluster (EFC) — exact API surface, routing rules, Pre-Flight lifecycle, task internals, and a hard list of things that do NOT exist. Load before writing any EFC code to avoid hallucination.
user-invocable: true
---

# Express File Cluster (EFC) — Skill

Use this skill whenever you're reading, writing, or debugging EFC code. It loads the exact source-derived facts about this framework so you never invent APIs, import paths, or behaviours that don't exist.

## When to load

- Writing a new route, task, model, or middleware
- Debugging a boot failure or a missing-route issue
- Answering "does EFC support X?" questions
- Any time you're about to type an `import` from `express-file-cluster`

## Routing table — open the module that matches the work

| Situation | Open |
|---|---|
| What is exported and from where | [api-surface.md](api-surface.md) |
| How file paths become URL paths | [routing-rules.md](routing-rules.md) |
| Worker boot sequence (Pre-Flight) | [pre-flight.md](pre-flight.md) |
| Background tasks — defineTask, enqueue, thread, cron, pg-boss, dead letters | [tasks-internals.md](tasks-internals.md) |
| Auth — issueToken, requireAuth internals | [auth-internals.md](auth-internals.md) |
| Things that do NOT exist (anti-hallucination) | [what-not-to-invent.md](what-not-to-invent.md) |

Load **only** the module the work points to. Each is self-contained.

## Project location

```
<repo root>/
  packages/core/src/      ← framework source
  packages/create-efc-app/src/  ← scaffolder
  docs/                   ← full documentation
```

## Status (v0.12.1 — Beta, Phase 2 complete + defineTable with relations + generated migrations + `efc add` registry)

Implemented: file-based router (incl. `[[id]]`, `[...slug]`, `[[...slug]]`), request validation (`export const schema`, Standard Schema), multi-core clustering with graceful shutdown, http-only cookie + Bearer token auth (scrypt password hashing built in), structured logging (pino, request IDs), `defineModel` on MongoDB (mongoose) **and** PostgreSQL (Drizzle) with validation, query options, bulk ops, transactions, `sync()`/`drop()`, PostgreSQL-native `defineTable` (Prisma-style queries, foreign keys, many-to-many, `include`, relation filters, nested writes), MongoDB-native `defineCollection` (mongoose vocabulary, BSON types, geo/text, `bulkWrite`, change streams), query logging (`logging.queries`), BullMQ **and** pg-boss task backends with cron schedules and dead-letter CLI, worker_threads for CPU-bound tasks, migrations/seeds/studio (`efc db`) incl. migrations generated from model diffs (`efc db generate`), `efc db pull` and `efc import-prisma`, full CLI.

**Not yet implemented (Phase 3+):** plugins, `efc lint`, `efc deploy`.

Phase 3 testing utilities: `createTestApp` from `express-file-cluster/testing` mounts a real route tree without service boot or a listener. Read `docs/guides/testing.md` and `docs/api-reference/testing.md`; see process-wide auth/logging isolation limits.

M6 completed 2026-10-30: query logging + bounded opt-in query metrics, editable studio, pool settings + bounded prepared statements, and a strict 10% nightly benchmark gate. See `bench/results/m6-validation.md` for measured evidence. OpenTelemetry instrumentation is implemented in the 0.12.0 release.

Since 0.11.0: OpenAPI 3.1 generation (`generateOpenAPI`, `ignite({ openapi })`) and file `WS` exports with HTTP middleware/auth, origin/payload limits, heartbeat and drain. Read `docs/guides/openapi.md`, `docs/api-reference/openapi.md`, `docs/guides/websockets.md`, `docs/api-reference/websockets.md`. These APIs are available since 0.11.0.

Since 0.12.0: opt-in HTTP/task OpenTelemetry instrumentation (`tracing: true | TracingOptions`). Read `docs/guides/tracing.md` and `docs/api-reference/tracing.md`; the app owns SDK/context manager/exporter and shutdown. Native task propagation requires BullMQ ≥5.79.1 or pg-boss ≥12.38.0.
