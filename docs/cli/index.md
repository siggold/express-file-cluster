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
| `efc routes` | Print the resolved route table |
| `efc tasks` | List registered background tasks |
| `efc doctor` | Validate config, env vars, and project setup |

---

## Detailed pages

- [start / build / run](./start.md) — Lifecycle commands
- [generate](./generate.md) — Code generation
- [diagnostics](./diagnostics.md) — `routes`, `tasks`, `doctor`
