# CLI Reference

EFC ships a single `efc` binary installed as a dev dependency when you use `create-efc-app`. The scaffolder (`npx create-efc-app`) is a separate one-time tool.

---

## Installation

The `efc` binary is automatically available after scaffolding. For a manual install:

```bash
npm install --save-dev express-file-cluster
```

**Global vs project install.** `create-efc-app` also installs `efc` globally for convenience. Run inside a project, a global `efc` hands every command to the project's own `node_modules/express-file-cluster` — so commands always use the project's version, its database drivers and a single copy of the framework. Outside a project, the global install runs itself.

---

## Command overview

| Command | Description |
|---|---|
| `efc start dev` | Development server — hot-reload, single process |
| `efc start prod` | Production server — runs `dist/` with clustering |
| `efc build prod` | Type-check + transpile `src/` to `dist/src/` |
| `efc run tests` | Run tests via Vitest |
| `efc add <item...>` | Copy features (auth, portals, billing, mailer…) into the app from the registry |
| `efc list` / `efc view <item>` | List registry items / print an item's files |
| `efc diff [item]` | Compare installed features with the registry |
| `efc init` | Write `efc.json` for an app made before 0.8 |
| `efc generate route <path>` | Scaffold a route file |
| `efc generate task <name>` | Scaffold a task file |
| `efc generate middleware <name>` | Scaffold a middleware file |
| `efc generate migration <name>` | Scaffold a timestamped migration |
| `efc generate seed <name>` | Scaffold a seed script |
| `efc db generate [name] [--allow-drop] [--tighten] [--verify]` | Write a migration from the models (or verify the migrations match them) |
| `efc db migrate [--baseline] \| rollback \| status` | Run, revert and inspect migrations |
| `efc db sync [--dry-run] [--exit-code]` | Bring the database in line with the models; `--exit-code` exits 2 on drift |
| `efc db pull [--out dir] [--force]` | Write `defineTable` models for an existing PostgreSQL database |
| `efc import-prisma [schema.prisma] [--out dir]` | Write `defineTable` models from a Prisma schema |
| `efc db seed [name]` | Run seed scripts |
| `efc db studio` | Read-only database browser on 127.0.0.1 |
| `efc routes` | Print the resolved route table |
| `efc tasks` | List registered background tasks |
| `efc tasks failed \| retry \| purge` | Inspect and act on dead-lettered jobs |
| `efc doctor` | Validate config, env vars, and project setup |
| `efc --version` | Print the installed version |

---

## Detailed pages

- [start / build / run](./start.md) — Lifecycle commands
- [add](./add.md) — the feature registry: `add`, `list`, `view`, `diff`, `init`
- [generate](./generate.md) — Code generation
- [db](./db.md) — migrations, seeds, studio
- [diagnostics](./diagnostics.md) — `routes`, `tasks` (incl. dead letters), `doctor`
