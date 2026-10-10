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
| Background tasks — defineTask, enqueue, thread | [tasks-internals.md](tasks-internals.md) |
| Auth — issueToken, requireAuth internals | [auth-internals.md](auth-internals.md) |
| Things that do NOT exist (anti-hallucination) | [what-not-to-invent.md](what-not-to-invent.md) |

Load **only** the module the work points to. Each is self-contained.

## Project location

```
/home/prashant/Projects/temp-nodejs/
  packages/core/src/      ← framework source
  packages/create-efc-app/src/  ← scaffolder
  usage/                  ← example app
  docs/                   ← full documentation
```

## Status (v0.3.16 — Beta)

Implemented: file-based router, multi-core clustering, http-only + localStorage auth, MongoDB adapter (`mongoose`), BullMQ task queue, worker_threads for CPU-bound tasks, full CLI.

**Not yet implemented:** PostgreSQL adapter, pg-boss backend, wildcard/catch-all routes, cron tasks, WebSockets, plugins, OpenAPI.
