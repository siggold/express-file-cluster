# AGENTS.md — express-file-cluster (EFC)

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, Gemini, …) working in
this repository. **Read the docs before you write code.** EFC is a young framework: its API is
not in your training data, and guessing produces imports, options and methods that don't exist.

---

## 1. Go through the docs first

Before changing or generating any code, read in this order:

1. **[`Skills/efc/SKILL.md`](Skills/efc/SKILL.md)** — what EFC is, its status, and which reference
   card to open for which job.
2. **[`Skills/efc/api-surface.md`](Skills/efc/api-surface.md)** — every public export and its exact
   signature. If it isn't here, it doesn't exist.
3. **[`Skills/efc/what-not-to-invent.md`](Skills/efc/what-not-to-invent.md)** — APIs, import paths and
   features that do **not** exist. Check it before using anything you "remember".
4. **[`docs/index.md`](docs/index.md)**, then the pages for the area you're touching:

| You are working on… | Read |
|---|---|
| Routes, URL patterns, params, 405s | `docs/core-concepts/file-based-routing.md`, `Skills/efc/routing-rules.md` |
| Middleware, `compose()` | `docs/core-concepts/middleware.md`, `docs/api-reference/compose.md` |
| Request validation (`export const schema`) | `docs/guides/validation.md` |
| `ignite()` options, boot order | `docs/api-reference/ignite.md`, `Skills/efc/pre-flight.md` |
| Models, queries, transactions (MongoDB / PostgreSQL) | `docs/guides/database.md`, `docs/api-reference/db.md` |
| PostgreSQL-native models (`defineTable`, Prisma-style) | `docs/api-reference/table.md` |
| Migrations (incl. `efc db generate`, `pull`), seeds, `efc db` | `docs/guides/migrations.md`, `docs/cli/db.md` |
| Coming from Prisma, `efc import-prisma` | `docs/guides/coming-from-prisma.md` |
| Auth, roles, sessions | `docs/guides/authentication.md`, `docs/api-reference/auth.md`, `docs/guides/rbac.md`, `Skills/efc/auth-internals.md` |
| Background tasks, cron, dead letters | `docs/core-concepts/background-tasks.md`, `docs/api-reference/tasks.md`, `Skills/efc/tasks-internals.md` |
| Cache, logging, errors | `docs/guides/caching.md`, `docs/guides/logging.md`, `docs/guides/error-handling.md` |
| Clustering, deployment, env vars | `docs/core-concepts/clustering.md`, `docs/guides/deployment.md`, `docs/guides/environment-variables.md` |
| The CLI (`efc …`) | `docs/cli/index.md` and the page per command |
| The scaffolder (`create-efc-app`), `efc add` registry | `docs/getting-started/index.md`, `docs/cli/add.md`, `docs/guides/generated-portals.md` |

Search when unsure: `grep -rn "<term>" docs Skills/efc`.

**[`CLAUDE.md`](CLAUDE.md)** holds the repository's ground-truth rules (routing, tasks, database,
boot order, common mistakes, what's not implemented). It applies to every agent, not only Claude.

## 2. Rules that are easy to get wrong

- Only three import paths exist: `express-file-cluster`, `express-file-cluster/auth`,
  `express-file-cluster/tasks`.
- `ignite()` does not load `efc.config.ts`, and `apiDir` / `tasksDir` are not options — `src/api`
  and `src/tasks` are found by convention.
- Don't document, scaffold or suggest features listed as not implemented in `CLAUDE.md`.
- When the docs and the code disagree, the code in `packages/core/src` wins — then fix the docs.

## 3. The docs ship with the packages

`npm run build` copies `docs/` and `Skills/efc/` into each package's `dist/docs`
(`scripts/bundle-docs.mjs`):

- **`express-file-cluster`** → `node_modules/express-file-cluster/dist/docs/` in every app, matching
  the installed version. Agents in an EFC app should read the docs from there.
- **`express-file-cluster-mcp`** (`packages/mcp`) → an MCP server serving the same docs, plus the
  `get-rules`, `list-docs`, `get-doc`, `search-docs`, `resolve-route`, `scaffold-route` and
  `scaffold-task` tools:

  ```bash
  claude mcp add efc -- npx -y express-file-cluster-mcp
  ```

  Other clients: command `npx`, args `["-y", "express-file-cluster-mcp"]`, transport stdio.

## 4. When you change behaviour, change the docs in the same PR

Every user-visible change updates, together: `docs/` (guide + API reference), the matching
`Skills/efc/*.md` card, `CLAUDE.md` if a ground rule moved, `todo.md`, and tests. The bundled docs
and the MCP server are built from these files, so stale docs ship to every user and agent.

## 5. Working in this repo

```
packages/core/           express-file-cluster (framework source in src/)
packages/create-efc-app/ npx create-efc-app scaffolder
packages/mcp/            express-file-cluster-mcp (docs MCP server)
docs/  Skills/efc/       documentation and dense reference cards
```

```bash
npm ci                  # install (npm workspaces)
npm run lint
npm run typecheck
npm run build           # also bundles docs into dist/docs
npm test                # integration tests self-skip without MongoDB / Redis / PostgreSQL
```

Integration tests need MongoDB on `27017` (+ replica set on `27018` for transactions), Redis on
`6379` and PostgreSQL via `EFC_TEST_PG_URL`; see `CLAUDE.md`.
