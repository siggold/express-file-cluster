# EFC Documentation

**express-file-cluster (EFC)** is an opinionated backend framework built on Express. It removes routing ceremony, saturates every CPU core automatically, and ships a production-grade background-task subsystem — all from a single `ignite()` call.

> **Status: v0.3.16 — Beta.** The router, clustering, auth, MongoDB adapter, and BullMQ task queue are implemented. PostgreSQL and the pg-boss task backend are scaffolded as choices but not yet implemented in the runtime.

---

## What EFC solves

| Pain point | EFC's answer |
|---|---|
| Route registration boilerplate | The file tree **is** the route tree |
| Single-threaded Node under load | CPU-count auto-detection → worker processes |
| Blocking work on the request path | `enqueue()` ships it off-path with retries |
| Wiring DB, auth, and middleware by hand | `ignite()` bootstraps everything in one call |

---

## Documentation sections

| Section | What you'll find |
|---|---|
| [Getting Started](./getting-started/index.md) | Scaffold a project, understand the structure |
| [Core Concepts](./core-concepts/index.md) | The four pillars: routing, clustering, tasks, middleware |
| [API Reference](./api-reference/ignite.md) | Every exported function and type, fully documented |
| [Guides](./guides/authentication.md) | Deep-dives: auth, database, RBAC, mailer, error handling, deployment |
| [CLI](./cli/index.md) | All `efc` commands with flags and examples |
| [Contributing](./contributing/index.md) | Roadmap, branch conventions, PR requirements |

### Guides

| Guide | Covers |
|---|---|
| [Authentication](./guides/authentication.md) | JWT strategies, login/logout, `requireAuth` |
| [RBAC](./guides/rbac.md) | Role-based route protection via the `requireAuth('role')` shorthand |
| [Database](./guides/database.md) | `defineModel`, CRUD, MongoDB vs PostgreSQL status |
| [Generated Portals](./guides/generated-portals.md) | Every model and route `create-efc-app` scaffolds for the User/Admin portals |
| [Mailer](./guides/mailer.md) | Gmail (app password) and custom SMTP setup, sending email from a task |
| [Environment Variables](./guides/environment-variables.md) | Full `.env` reference |
| [Error Handling](./guides/error-handling.md) | `HttpError`, custom handlers, task failures |
| [Deployment](./guides/deployment.md) | Build, start, and ship to production |

### Tooling

An [MCP server](https://github.com/pr4shxnt/efc.js/tree/main/mcp) ships in this repo (`mcp/`) that exposes this documentation as tools, resources, and prompts to MCP-compatible AI assistants (Claude, Cursor, etc.) — useful if you want an assistant to scaffold routes/tasks or answer "does EFC support X?" without hallucinating. See `mcp/README.md` for setup.

---

## Five-minute overview

```bash
# 1. Scaffold
npx create-efc-app my-api
cd my-api

# 2. Run in dev mode (hot-reload, single process)
npm run dev          # → efc start dev

# 3. Drop a file → get a route
# src/api/users/[id].ts  →  GET /users/:id
```

```ts
// src/api/users/[id].ts
import type { Request, Response } from 'express';

export const GET = async (req: Request, res: Response) => {
  res.json({ id: req.params.id });
};
```

```ts
// src/index.ts
import { ignite, gracefulShutdown } from 'express-file-cluster';
import config from '../efc.config.js';

// efc.config.ts reads PORT, DATABASE_URL, JWT_SECRET, CORS_ORIGINS from .env explicitly —
// ignite() itself never touches process.env for these (see Environment Variables guide)
ignite({
  ...config,
}).then(gracefulShutdown).catch(console.error);
```

The framework always scans `src/api/` on boot (this path is a fixed convention, not configurable), derives route paths from file names, forks `os.cpus().length` worker processes in production (single-process in dev — `ignite()`'s own default, don't override it with a hardcoded `cluster: true`), and handles `SIGTERM`/`SIGINT` gracefully — zero extra code required.
