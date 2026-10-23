# EFC Documentation

**express-file-cluster (EFC)** is an opinionated backend framework built on Express. It removes routing ceremony, saturates every CPU core automatically, and ships a production-grade background-task subsystem — all from a single `ignite()` call.

> **Status: v0.9.0 — Beta.** File-based routing (incl. catch-all and optional segments), request validation, clustering, auth, structured logging, MongoDB and PostgreSQL models with types inferred from the schema, PostgreSQL-native `defineTable` (Prisma-style queries and relations: foreign keys, many-to-many, `include`, relation filters, nested writes), query logging, BullMQ and pg-boss tasks with cron and dead-letter tooling, migrations (written for you from model changes: `efc db generate`, plus `efc db pull` and `efc import-prisma`), and the `efc add` feature registry (auth, admin, billing… copied into your app as source you own) are all implemented.

---

## What EFC solves

| Pain point | EFC's answer |
|---|---|
| Route registration boilerplate | The file tree **is** the route tree |
| Single-threaded Node under load | CPU-count auto-detection → worker processes |
| Blocking work on the request path | `enqueue()` ships it off-path with retries; `schedule` runs it on cron |
| Wiring DB, auth, and middleware by hand | `ignite()` bootstraps everything in one call |
| Different code per database | `defineModel` runs the same on MongoDB and PostgreSQL |
| Hand-rolled input checks | `export const schema` validates params, query and body |

---

## Documentation sections

| Section | What you'll find |
|---|---|
| [Getting Started](./getting-started/index.md) | Scaffold a project, understand the structure |
| [Core Concepts](./core-concepts/index.md) | The four pillars: routing, clustering, tasks, middleware |
| [API Reference](./api-reference/ignite.md) | Every exported function and type, fully documented |
| [Guides](./guides/authentication.md) | Deep-dives: auth, OAuth, database, RBAC, mailer, error handling, deployment |
| [CLI](./cli/index.md) | All `efc` commands with flags and examples |
| [Contributing](./contributing/index.md) | Roadmap, branch conventions, PR requirements |

### Guides

| Guide | Covers |
|---|---|
| [Authentication](./guides/authentication.md) | JWT strategies, login/logout, `requireAuth` |
| [RBAC](./guides/rbac.md) | Role-based route protection via the `requireAuth('role')` shorthand |
| [Database](./guides/database.md) | `defineModel`, queries, transactions, MongoDB vs PostgreSQL |
| [Which model API?](./guides/which-api.md) | `defineModel` vs `defineTable`, and moving between them |
| [Relations](./guides/relations.md) | Foreign keys, many-to-many, `include`, relation filters, nested writes |
| [defineTable](./api-reference/table.md) | PostgreSQL-native models: Prisma-style queries, SQL types, aggregation |
| [Migrations & Seeds](./guides/migrations.md) | `efc db generate / migrate / rollback / pull / seed / studio`, drift checks |
| [Coming from Prisma](./guides/coming-from-prisma.md) | `efc import-prisma`, schema and query mapping |
| [Validation](./guides/validation.md) | Route `schema` exports with zod, valibot, arktype |
| [Logging](./guides/logging.md) | pino, request IDs, `getLogger()` |
| [Caching & Sessions](./guides/caching.md) | `cache`, `cacheResponse`, revoking JWT sessions |
| [Generated Portals](./guides/generated-portals.md) | Every model and route `create-efc-app` scaffolds for the User/Admin portals |
| [Mailer](./guides/mailer.md) | Gmail (app password) and custom SMTP setup, sending email from a task |
| [Sign in with Google & Apple](./guides/oauth.md) | `efc add auth@google` / `auth@apple`: setup, flow, account linking |
| [Environment Variables](./guides/environment-variables.md) | Full `.env` reference |
| [Error Handling](./guides/error-handling.md) | `HttpError`, custom handlers, task failures |
| [Deployment](./guides/deployment.md) | Build, start, and ship to production |
| [AI Coding Agents](./guides/ai-agents.md) | Docs bundled in the package, `AGENTS.md`, the `express-file-cluster-mcp` server |

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
