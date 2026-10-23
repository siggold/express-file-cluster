# efc add — the feature registry

EFC apps start small and grow one feature at a time, the way [shadcn/ui](https://ui.shadcn.com) works for components. `create-efc-app` writes the **base** app: the server, `src/api`, `src/tasks` and the database. `efc add` copies ready-made **features** into it: auth (email/password, Google, Apple), a user portal, an admin portal, billing, an email client and more.

The copied files are ordinary source in your app. You read them, change them and commit them. Nothing about a feature is hidden in a package.

```bash
efc list                              # what can be added
efc add auth forgot-password          # copy features in (dependencies come along)
efc add email-client                  # asks for your SMTP settings
efc add auth@google auth@apple        # asks for the OAuth credentials
efc view billing                      # read an item's files before adding it
efc diff                              # compare installed features with the registry
```

---

## Commands

| Command | What it does |
|---|---|
| `efc add <item...>` | Shows the plan (files, packages, env vars), asks to confirm, asks the items' [questions](#questions) (SMTP settings, OAuth credentials…), then writes the files, adds the packages to `package.json`, runs your package manager, and writes the answers to `.env` (placeholders to `.env.example`) |
| `efc list` | Lists every item by group; installed ones are ticked |
| `efc view <item> [--json]` | Prints an item's files as they'd be written for *this* app (language + database) |
| `efc diff [item]` | For installed items, shows each file that was changed in the app or has a newer registry version, with a line diff |
| `efc init [--force]` | Writes `efc.json` for an existing app (detects language, database, model API and task backend). `efc add` does this itself when there's no `efc.json` yet |

`efc add` options:

| Flag | |
|---|---|
| `-y, --yes` | Skip the confirmation. Required when not in a terminal (CI, agents) |
| `--dry-run` | Print the plan and stop |
| `--overwrite` | Replace files you've changed with the registry version |
| `--no-install` | Don't run `npm install` / `pnpm install` / … afterwards |
| `--no-prompt` | Don't ask the items' questions — write placeholders to `.env` instead |

---

## Items

| Item | Adds | Needs |
|---|---|---|
| `auth` | `User` + `Admin` models; `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /auth/me` | — |
| `auth@google` | Sign in with Google: `GET /auth/google` → Google → `GET /auth/google/callback` (+ `OAuthAccount` model). Asks for the client ID / secret | auth |
| `auth@apple` | Sign in with Apple: `GET /auth/apple` → Apple → `POST /auth/apple/callback` (+ `OAuthAccount`). Asks for Services ID, Team ID, Key ID and the `.p8` key | auth |
| `user-profile` | `GET/PUT /user/profile` | auth |
| `forgot-password` | `/auth/forgot-password`, `/auth/reset-password` | auth |
| `account-security` | change password, 2FA, sessions, token refresh + `Session` model | auth |
| `email-verification` | `/auth/verify-email`, resend | auth |
| `account-settings` | avatar, settings, account, dashboard, activity | auth |
| `notifications` | `Notification` model + `/user/notifications` | auth |
| `files` | `File` model + files, favorites, bookmarks, search | auth |
| `billing` | `Plan`, `Subscription`, `Invoice`, `ApiKey` + user billing & API-key routes | auth |
| `support` | `SupportTicket` model + `/support/tickets` | auth |
| `admin` | `GET /admin/dashboard` (stats), behind `requireAuth('admin')` | auth |
| `admin-users` | list / create / suspend / verify / export users | admin |
| `admin-admins` | manage admins + `Role` model | admin |
| `admin-analytics` | users, revenue, traffic | admin |
| `admin-content` | `FAQ`, `Blog`, `Category` + admin CRUD | admin |
| `admin-billing` | `Plan`, `Coupon` + plans, coupons, subscriptions | admin |
| `admin-support` | `SupportTicket` + view & respond to tickets | admin |
| `admin-logs` | `AuditLog`, `Notification` + broadcast, audit/activity/security logs | admin |
| `admin-system` | settings, health, cache | admin |
| `email-client` (alias `mailer`) | replaces the `SendEmail` stub with a real SMTP sender (nodemailer). Asks for Gmail or a custom SMTP server and its credentials | — |

The full route list is in [Generated Portals](../guides/generated-portals.md); OAuth setup is in [Sign in with Google & Apple](../guides/oauth.md).

A few things hold for every item:

- **Dependencies come along.** `efc add admin-users` also installs `auth` and `admin` if they're missing.
- **Routes that send email** (`auth`, `forgot-password`, `email-verification`) enqueue the `SendEmail` task. The base app has a stub that logs the message. `efc add email-client` swaps in real SMTP. These items need a task backend (`tasks` in `efc.config`); the base app always has one.
- **Models shared by two items** (`Plan`, `SupportTicket`, `Notification`) are identical in both. The second item skips the file that's already there.
- **On PostgreSQL with `defineTable`**, references are real foreign keys, and `efc add` registers new models in `src/model/index.ts` (the export plus the `Tables` entry). Models declare no back-relations. Add `relations: { … }` to a model when you want `include`. See [defineTable](../api-reference/table.md).
- **Tables and collections** are created on first use (`autoSync`). With `autoSync: false`, run `efc db sync` or write a migration.

---

## Questions

Some items need settings only you have. `efc add` asks for them in the terminal, and so does `create-efc-app` when you pick the feature there. The answers go straight into `.env` (gitignored); `.env.example` only ever gets placeholders.

```
$ efc add email-client

  Configuration  (saved to .env)

  Email provider:
    1) Gmail  smtp.gmail.com, preconfigured
    2) Other (custom SMTP)  you'll provide host + port
  Choose 1-2 (1): 1
  Gmail address: you@gmail.com
  Gmail app password (16 characters):            ← hidden
  From address: (you@gmail.com)
  App URL (used in email links): (http://localhost:3000)
```

| Item | Asks for |
|---|---|
| `email-client` | Gmail or custom SMTP; host + port (custom); user; password (Gmail: a 16-character App Password); from address; app URL |
| `auth@google` | `GOOGLE_CLIENT_ID` (checked: `….apps.googleusercontent.com`), `GOOGLE_CLIENT_SECRET` (hidden), redirect URI, where to send the browser after sign-in |
| `auth@apple` | Services ID, Team ID and Key ID (10 characters each), the path to your `.p8` key (its contents are stored in `APPLE_PRIVATE_KEY`, newlines as `\n`), return URL (must be https), where to send the browser after sign-in |

Wrong answers are asked again. A question is only asked for a variable the app doesn't have yet, so re-adding an item never overwrites your settings. Without a terminal (CI, coding agents), or with `--no-prompt`, nothing is asked: the variables get placeholders and `efc add` lists the ones to fill in.

---

## efc.json

`create-efc-app` writes `efc.json` at the project root. Commit it.

```json
{
  "registry": "0.9.0",
  "language": "typescript",
  "database": "postgresql",
  "modelApi": "defineTable",
  "tasks": "pg-boss",
  "items": ["auth", "billing"],
  "files": {
    "src/api/auth/login.ts": "9f2c…",
    "src/model/User.ts": "41ab…"
  }
}
```

- `language`, `database` and `modelApi` pick the variant of each item: TypeScript or JavaScript, and MongoDB, PostgreSQL `defineModel` or PostgreSQL `defineTable`.
- `files` is the sha256 of every file as efc last wrote it. This is how `efc add` tells a file you haven't touched (safe to update) from one you've changed (left alone unless `--overwrite`). For example, `efc add email-client` replaces the base `SendEmail` stub only if you haven't edited it.

Apps created before 0.8 have no `efc.json`. `efc add` detects the variant from `package.json` and `src/`, then creates the file. Files that already exist count as yours: if they differ from the registry, they show up as conflicts and are never overwritten silently.

---

## Where the registry comes from

The registry ships inside `express-file-cluster` (`node_modules/express-file-cluster/dist/registry`), rendered from the same templates `create-efc-app` uses. Items therefore always match the framework version you have installed, and `efc add` works offline. After upgrading `express-file-cluster`, `efc diff` shows what changed in the features you installed, and `efc add <item>` updates the files you haven't touched.
