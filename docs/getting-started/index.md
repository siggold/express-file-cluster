# Getting Started

## Prerequisites

- Node.js 18 or later
- npm 9 or later
- (Optional) MongoDB or Redis if you need a database or background tasks

---

## Scaffold a new project

```bash
npx create-efc-app my-api
```

The interactive wizard walks through:

```
? Project name:            my-api
? Language:                TypeScript | JavaScript
  Database:                MongoDB (shown, not asked)
? Authentication strategy: http-only | localStorage
? Features: (space to toggle)
    ◉ Multi-core clustering
    ◉ Background tasks
    ◉ API route documentation
    ◉ User portal
    ◉ Admin portal
    ◉ Role-based access control
    ◯ Mailer
```

> **MongoDB and BullMQ are the only backends the runtime supports today**, so the wizard no longer offers PostgreSQL or pg-boss — they return as choices when the adapters land in Phase 2. See [Database](../guides/database.md).

Depending on what you toggle on, you'll see follow-up questions:

- **Background tasks** → uses `BullMQ` (Redis); set `REDIS_URL` in `.env`.
- **Mailer** → pick an email provider: `Gmail` (preconfigured `smtp.gmail.com`, no host/port to type) or `Other (custom SMTP)` (asks for host + port). Either way you're then asked for the sending email address and password. **For Gmail this must be a 16-character App Password, not your normal Gmail password** — the prompt validates the length and rejects anything that isn't 16 characters. See [Mailer](../guides/mailer.md) for the full walkthrough, including how to generate an App Password.
- **User portal / Admin portal** → scaffold a large set of ready-made models and routes (auth, profile, billing, support tickets, admin dashboard, content management, etc.). See [Generated Portals](../guides/generated-portals.md) for the complete list.
- **Role-based access control** → generates a `Role` model and swaps every protected route's `middlewares` export to use the `requireAuth('role')` shorthand instead of an inline guard. See [RBAC](../guides/rbac.md).

After confirmation it:

1. Writes the full project tree (see [Project Structure](./project-structure.md)).
2. Creates `efc.config.ts` pre-configured for your choices.
3. Generates `.env` (gitignored, `JWT_SECRET` pre-filled with `openssl rand -hex 64`, plus `SMTP_*` vars if you enabled the mailer) and `.env.example` (committed, documented placeholders).
4. Adds `.env` to `.gitignore`.
5. Writes `package.json` lifecycle scripts (`dev`, `build`, `start`, `test`).
6. Runs `npm install` with the dependencies for your selections, then installs the `efc` CLI globally.

---

## Generated `package.json` scripts

| Script | Expands to | When to use |
|---|---|---|
| `npm run dev` | `efc start dev` | Local development — hot-reload, single process |
| `npm run build` | `efc build prod` | CI/CD — type-check + compile to `dist/` |
| `npm start` | `efc start prod` | Production — runs `dist/` with clustering |
| `npm test` | `efc run tests` | Test suite via Vitest |

---

## First run

```bash
cd my-api
npm run dev
# [EFC] Worker primary listening on :3000
```

The server is live at `http://localhost:3000`. The scaffolder creates a `src/api/health.ts` route at `/health` as a smoke test.

---

## Next steps

- [Project Structure](./project-structure.md) — understand every file the scaffolder created.
- [File-Based Routing](../core-concepts/file-based-routing.md) — learn the naming rules.
- [Generated Portals](../guides/generated-portals.md) — full model/route inventory if you enabled User or Admin portal.
- [RBAC](../guides/rbac.md) — role-based route protection.
- [Mailer](../guides/mailer.md) — Gmail app-password and custom SMTP setup.
- [CLI Reference](../cli/index.md) — all `efc` commands.
