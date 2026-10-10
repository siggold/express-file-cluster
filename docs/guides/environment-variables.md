# Environment Variables

`ignite()` never reads `process.env` for application config — the one exception is `NODE_ENV`, a Node/Express-wide runtime-mode signal, not an app secret (see [Precedence](#precedence)). Every other runtime value (`PORT`, `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, ...) has to be read from `process.env` explicitly and passed into `ignite()` — there is no framework-level fallback to grab it for you.

The scaffolder wires this for you: it generates `.env` (gitignored, secrets pre-filled), `.env.example` (committed, documented placeholders), and `efc.config.ts` — which reads each variable explicitly and builds the `EFCConfig` object that `src/index.ts` spreads into `ignite()`. `efc.config.ts` is the single source of truth for what's actually applied; `.env` only matters because `efc.config.ts` chooses to read it.

---

## Variable reference

These are the variables the **scaffolded** `efc.config.ts` reads. If you hand-write your own config file, this list is a menu, not a contract — read only what you need.

| Variable | Required | Default | Wired into |
|---|---|---|---|
| `PORT` | No | `3000` | `config.port` |
| `NODE_ENV` | No | — | Read directly by the framework (not via config) — see [Precedence](#precedence). |
| `DATABASE_URL` | Yes (if using a database) | — | `config.databaseUrl`. Format determines the engine: `mongodb://...` or `postgres://...`. Also used by pg-boss and by `efc db` / `efc tasks` commands. |
| `JWT_SECRET` | Yes (if using auth) | — | `config.jwtSecret`. Generate with `openssl rand -hex 64`. |
| `JWT_EXPIRES_IN` | No | `7d` | `config.jwtExpiresIn`. Accepts `15m`, `1h`, `7d`, `30d`, etc. |
| `COOKIE_DOMAIN` | No | — | `config.cookieDomain`. Blank for localhost. |
| `REDIS_URL` | If tasks use BullMQ | `redis://localhost:6379` | `config.tasks.redisUrl`. Supports `rediss://` (TLS), ACL users and `/db`. Omitted for pg-boss projects — `efc tasks failed` picks BullMQ when it's set. |
| `EFC_DEBUG` | No | — | `1` makes `efc db` commands print full stack traces on failure. |
| `CORS_ORIGINS` | No | (all allowed) | `config.cors.origin` (comma-separated list, split into an array). Example: `http://localhost:3000,https://myapp.com` |
| `APP_URL` | If Mailer enabled | `http://localhost:3000` | Read directly in task/route code that builds email links (e.g. `${APP_URL}/auth/verify-email?token=...`) — not part of `EFCConfig`. |
| `SMTP_HOST` | If Mailer enabled | `smtp.gmail.com` | Read directly by the generated mailer task — not part of `EFCConfig`. |
| `SMTP_PORT` | If Mailer enabled | `465` (Gmail) / `587` (custom) | Same as above. `465` implies TLS (`secure: true`). |
| `SMTP_USER` | If Mailer enabled | — | Same as above. Sending email address / SMTP username. |
| `SMTP_PASS` | If Mailer enabled | — | Same as above. **For Gmail this must be a 16-character App Password** (Google Account → Security → 2-Step Verification → App passwords) — your regular Gmail password will be rejected by Google. See [Mailer](./mailer.md). |
| `SMTP_FROM` | If Mailer enabled | same as `SMTP_USER` | Same as above. `From:` address on outgoing mail. |

---

## Precedence

There's no env-vs-config precedence to reason about for most values, because the framework itself never reads them from `process.env` — `config.X` is whatever your `efc.config.ts` (or hand-written `ignite()` call) computes it to be. If you want an env var to win, read it yourself:

```ts
// efc.config.ts
const config: EFCConfig = {
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  jwtSecret: process.env.JWT_SECRET,
};
```

`NODE_ENV` is the one exception — it's a Node/Express-wide runtime-mode signal set by the platform (not authored in your app's `.env`), and the framework still reads it directly in three places: the cluster-in-production default (`config.cluster ?? process.env.NODE_ENV === 'production'`), the dev-only dashboard toggle, and the `http-only` auth strategy's cookie `Secure` flag. An explicit `config.cluster` always overrides the `NODE_ENV`-derived default.

---

## Secret hygiene

- **Never commit `.env`.** The scaffolder adds it to `.gitignore` automatically.
- **Use a different `JWT_SECRET` per environment** (dev, staging, production). Rotating the secret invalidates all existing tokens.
- **Regenerate if exposed:**

  ```bash
  openssl rand -hex 64
  ```

  Paste the output into your `.env` and your deployment platform's secret store.

- **Do not log secrets.** EFC never echoes `JWT_SECRET` or `REDIS_URL` to stdout.

---

## `.env` vs `efc.config.ts`

| File | Purpose | Committed? |
|---|---|---|
| `.env` | Runtime secrets and per-environment values, read by `efc.config.ts` | **No** |
| `.env.example` | Documented template of every required variable | Yes |
| `efc.config.ts` | Reads `.env` explicitly and builds the `EFCConfig` object `ignite()` receives — both runtime values and structural choices (`authStrategy`, `tasks.backend`) live here | Yes |

There is no `apiDir`/`tasksDir` option — `src/api/` and `src/tasks/` are fixed conventions.

---

## Development `.env` example

```bash
PORT=3000
NODE_ENV=development

DATABASE_URL=mongodb://localhost:27017/my-api-dev

JWT_SECRET=<generated-by-scaffolder>
JWT_EXPIRES_IN=7d

REDIS_URL=redis://localhost:6379

CORS_ORIGINS=http://localhost:5173

# Only present if the Mailer feature was enabled during scaffolding
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@example.com
SMTP_PASS=abcdefghijklmnop # Gmail App Password (16 chars) — not your Gmail login password
SMTP_FROM=you@example.com
```

---

## Loading in development

In development (`efc start dev`), the CLI loads `.env` into `process.env` before your app runs, so `efc.config.ts`'s `process.env.X` reads see it. It re-reads `.env` fresh on every `tsx watch` restart — editing `.env` and saving a source file is enough to pick up the change, no need to stop and restart `efc start dev` itself. Variables already present in `process.env` (e.g. real OS-exported vars, CI-injected secrets) take precedence over `.env`.

In production (`efc start prod`), `.env` is **not** loaded. Platforms (Docker, Kubernetes, Railway, Heroku) inject secrets directly into `process.env`, and `efc.config.ts`'s `process.env.X` reads pick those up the same way. This is intentional — avoid reading secret files from disk in production.
