# Contributing

## Repository layout

```
packages/
  core/              → express-file-cluster  (the framework)
  create-efc-app/    → interactive scaffolder CLI
usage/               → example app used for manual testing
client/              → minimal frontend for the example app
```

---

## Getting started

```bash
git clone https://github.com/your-org/efc.js.git
cd efc.js

# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Run the test suite
npm test

# Type-check
npm run typecheck

# Lint
npm run lint
```

---

## Running the example app

The `usage/` directory is a self-contained EFC application wired against the local `packages/core` build. Use it for end-to-end manual testing.

```bash
cd usage
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, REDIS_URL
npm install
npm run dev            # efc start dev
```

The `client/` directory at the repo root is a minimal HTML/JS frontend that calls the usage app's API.

---

## Branch naming

| Type | Pattern | Example |
|---|---|---|
| Feature | `feat/<topic>` | `feat/postgresql-adapter` |
| Bug fix | `fix/<topic>` | `fix/route-sort-order` |
| Documentation | `docs/<topic>` | `docs/task-guide` |
| Chore | `chore/<topic>` | `chore/bump-bullmq` |

---

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(router): support catch-all wildcard routes
fix(cluster): prevent infinite respawn loop on startup crash
docs(auth): add localStorage strategy example
chore(deps): upgrade jose to v5
```

---

## Pull requests

Every PR must:

- Include tests for changed behaviour (unit or integration via Vitest).
- Pass `npm test`, `npm run lint`, and `npm run typecheck` in CI.
- Include a changelog entry under `Unreleased` in `CHANGELOG.md`.

---

## Package architecture

### `packages/core`

The framework package published as `express-file-cluster`. Sub-path exports:

| Import | Source |
|---|---|
| `express-file-cluster` | `src/index.ts` — `ignite`, `gracefulShutdown`, `HttpError`, `compose`, `db`, `defineModel` |
| `express-file-cluster/auth` | `src/auth/index.ts` — `issueToken`, `revokeToken`, `signToken`, `requireAuth` |
| `express-file-cluster/tasks` | `src/tasks/index.ts` — `defineTask`, `enqueue` |
| `express-file-cluster/cli` | `src/cli/index.ts` — the `efc` binary |

### `packages/create-efc-app`

Interactive scaffolder published as `create-efc-app`. Invoked with `npx create-efc-app <name>`. Prompts the user and writes the project tree using the templates in `src/scaffold.ts`.

---

## Roadmap

| Phase | Target | Focus |
|---|---|---|
| **1** | Done | Core MVP — router, clustering, auth, DB, tasks, CLI |
| **2** | Done | Beta — PostgreSQL, pg-boss, request validation, structured logging, cron tasks, catch-all routes, migrations, `defineModel` upgrades |
| **3** | Q1 2027 | Stable v1.0 — plugins, WebSockets, OpenAPI, OpenTelemetry, testing utilities |
| **4** | 2027+ | Edge/serverless, gRPC, GraphQL |

### Bug fix SLA

| Severity | SLA | Example |
|---|---|---|
| **P0 — Critical** | Patch within 48 h | Data loss, auth bypass, crash on startup |
| **P1 — High** | Patch within 1 week | Route not resolving, worker not respawning, task silently dropped |
| **P2 — Medium** | Next minor release | Wrong TypeScript types, misleading error message |
| **P3 — Low** | Best effort | Cosmetic CLI issues, doc typos |

---

## Influencing the roadmap

1. **Open a GitHub Discussion** — propose a feature or share a use case.
2. **Upvote issues** — 👍 reactions influence prioritisation.
3. **Submit a PR** — the fastest path from idea to shipping.
