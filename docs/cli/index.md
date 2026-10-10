# CLI Reference

EFC ships a single `efc` binary installed as a dev dependency when you use `create-efc-app`. The scaffolder (`npx create-efc-app`) is a separate one-time tool.

---

## Installation

The `efc` binary is automatically available after scaffolding. For a manual install:

```bash
npm install --save-dev express-file-cluster
```

---

## Command overview

| Command | Description |
|---|---|
| `efc start dev` | Development server — hot-reload, single process |
| `efc start prod` | Production server — runs `dist/` with clustering |
| `efc build prod` | Type-check + transpile `src/` to `dist/src/` |
| `efc run tests` | Run tests via Vitest |
| `efc generate route <path>` | Scaffold a route file |
| `efc generate task <name>` | Scaffold a task file |
| `efc generate middleware <name>` | Scaffold a middleware file |
| `efc generate migration <name>` | Scaffold a timestamped migration |
| `efc generate seed <name>` | Scaffold a seed script |
| `efc db migrate \| rollback \| status` | Run, revert and inspect migrations |
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
- [generate](./generate.md) — Code generation
- [db](./db.md) — migrations, seeds, studio
- [diagnostics](./diagnostics.md) — `routes`, `tasks` (incl. dead letters), `doctor`
