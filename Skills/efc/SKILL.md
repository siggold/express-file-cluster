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

## Status (v0.8.0 — Beta, Phase 2 complete + defineTable with relations + `efc add` registry)

Implemented: file-based router (incl. `[[id]]`, `[...slug]`, `[[...slug]]`), request validation (`export const schema`, Standard Schema), multi-core clustering with graceful shutdown, http-only + localStorage auth, structured logging (pino, request IDs), `defineModel` on MongoDB (mongoose) **and** PostgreSQL (Drizzle) with validation, query options, bulk ops, transactions, `sync()`/`drop()`, PostgreSQL-native `defineTable` (Prisma-style queries, foreign keys, many-to-many, `include`, relation filters, nested writes), query logging (`logging.queries`), BullMQ **and** pg-boss task backends with cron schedules and dead-letter CLI, worker_threads for CPU-bound tasks, migrations/seeds/studio (`efc db`) incl. migrations generated from model diffs (`efc db generate`), `efc db pull` and `efc import-prisma`, full CLI.

**Not yet implemented (Phase 3+):** WebSockets, plugins, OpenAPI generation, OpenTelemetry, `efc lint`, `efc deploy`, `defineCollection`.
