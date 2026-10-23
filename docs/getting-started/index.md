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

The interactive wizard asks for the **base** app, then offers features:

```
? Project name:            my-api
? Language:                TypeScript | JavaScript
? Database:                MongoDB | PostgreSQL
? Models:                  defineTable | defineModel        (PostgreSQL only)
? Task queue backend:      pg-boss | BullMQ                 (BullMQ on MongoDB)
? Multi-core clustering?   Yes
? Add features now?        (none by default — or add any later with `efc add`)
    Auth          ◯ Authentication  ◯ Sign in with Google  ◯ Sign in with Apple
    User portal   ◯ Profile  ◯ Forgot / reset password  ◯ Account security  …
    Admin portal  ◯ Admin portal  ◯ User management  ◯ Analytics  …
    Integrations  ◯ Email client
```

The base app is the server, `src/api` (with a `/health` route), `src/tasks` (with a `SendEmail` task stub) and the database connection. Everything else is a **feature** from the registry. You can pick features here or add them at any time with [`efc add`](../cli/add.md), which copies the same files in:

```bash
efc add auth forgot-password admin-users
```

On **PostgreSQL**, models default to [`defineTable`](../api-reference/table.md): PostgreSQL-native, with real foreign keys between the feature models (a user's sessions, invoices, tickets…) and Prisma-style queries in the generated routes. Pick **defineModel** instead for the portable API. On **MongoDB**, models are `defineModel`, which compiles to mongoose. See [Database](../guides/database.md).

Depending on what you pick, you'll see follow-up questions:

- **Task queue backend.** `pg-boss` stores jobs in your PostgreSQL, so there's no Redis to run. `BullMQ` uses Redis (`REDIS_URL` in `.env`).
- **Authentication** (or any feature that needs it) → pick a strategy: `http-only` (cookie) or `localStorage` (Bearer token).
- **Sign in with Google / Apple** → the OAuth client credentials (Apple: Services ID, Team ID, Key ID and the path to your `.p8` key). See [Sign in with Google & Apple](../guides/oauth.md).
- **Email client** → pick an email provider: `Gmail` (preconfigured `smtp.gmail.com`, no host or port to type) or `Other (custom SMTP)` (asks for host + port). Either way you're then asked for the sending email address and password. **For Gmail this must be a 16-character App Password, not your normal Gmail password.** The prompt rejects anything that isn't 16 characters. See [Mailer](../guides/mailer.md) for the full walkthrough, including how to generate an App Password.

Protected routes use `requireAuth('role')` (see [RBAC](../guides/rbac.md)). [Generated Portals](../guides/generated-portals.md) lists every route the features add.

After confirmation it:

1. Writes the full project tree (see [Project Structure](./project-structure.md)).
2. Creates `efc.config.ts` pre-configured for your choices.
3. Generates `.env` (gitignored, `JWT_SECRET` pre-filled with `openssl rand -hex 64`, plus `SMTP_*` vars if you enabled the mailer) and `.env.example` (committed, documented placeholders).
4. Adds `.env` to `.gitignore`.
5. Writes `package.json` lifecycle scripts (`dev`, `build`, `start`, `test`, `db:migrate`, `db:rollback`, `db:seed`, `db:studio`).
6. With features that have models, writes `src/migrations/00000000000000_init`, which creates every model's table/collection and indexes.
7. Writes `efc.json`: the app's variant, its features, and a hash of each file, which [`efc add`](../cli/add.md) uses later.
8. Runs `npm install` with the dependencies for your selections, then installs the `efc` CLI globally.

---

## Generated `package.json` scripts

| Script | Expands to | When to use |
|---|---|---|
| `npm run dev` | `efc start dev` | Local development — hot-reload, single process |
| `npm run build` | `efc build prod` | CI/CD — type-check + compile to `dist/` |
| `npm start` | `efc start prod` | Production — runs `dist/` with clustering |
| `npm test` | `efc run tests` | Test suite via Vitest |
| `npm run db:migrate` | `efc db migrate` | Apply pending migrations |
| `npm run db:rollback` | `efc db rollback` | Revert the last migration batch |
| `npm run db:seed` | `efc db seed` | Run seed scripts |
| `npm run db:studio` | `efc db studio` | Browse the database (read-only) |

---

## First run

```bash
cd my-api
npm run dev          # tables / indexes are created on first use — no migration needed
# 12:00:01 INFO  [primary] Worker primary listening on :3000
```

The server is live at `http://localhost:3000`. The scaffolder creates a `src/api/health.ts` route at `/health` as a smoke test.

---

## Next steps

- [Project Structure](./project-structure.md) — understand every file the scaffolder created.
- [File-Based Routing](../core-concepts/file-based-routing.md) — learn the naming rules.
- [Generated Portals](../guides/generated-portals.md) — full model/route inventory if you enabled User or Admin portal.
- [RBAC](../guides/rbac.md) — role-based route protection.
- [Mailer](../guides/mailer.md) — Gmail app-password and custom SMTP setup.
- [Migrations & Seeds](../guides/migrations.md) — evolving the schema.
- [Validation](../guides/validation.md) — `export const schema` with zod & co.
- [CLI Reference](../cli/index.md) — all `efc` commands.
