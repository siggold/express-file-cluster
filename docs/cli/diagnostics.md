# Diagnostics — `efc routes` / `efc tasks` / `efc doctor`

The three diagnostic commands inspect your project without starting the server.

---

## `efc routes`

Prints the route table resolved from the `src/api/` directory.

```bash
efc routes
```

**Sample output:**

```
  Route Table
  ────────────────────────────────────────────────────────────
  /health                              src/api/health.ts
  /users                               src/api/users/index.ts
  /posts/:slug/comments                src/api/posts/[slug]/comments.ts
  /users/:id                           src/api/users/[id].ts
  ────────────────────────────────────────────────────────────

  4 route(s) found
```

Static routes appear before dynamic routes (routes with `:param` segments), matching the registration order used at runtime.

**When to use:** after adding, renaming, or moving route files to verify the URL mapping is what you expect.

**Lookup order for the routes directory:** `src/api/` → `api/` → `dist/api/` (first that exists). This is a fixed convention — there is no `apiDir` config option.

---

## `efc tasks`

Lists the background tasks found in `src/tasks/`.

```bash
efc tasks
```

**Sample output:**

```
  Background Tasks

  SendEmail
  ResizeImage
  ProcessPayment
```

Each name corresponds to a file basename without extension. That is the string to pass to `enqueue()`.

**Lookup order for the tasks directory:** `src/tasks/` → `tasks/` → `dist/tasks/` (first that exists). This is a fixed convention — there is no `tasksDir` config option.

### Dead-letter queue: `efc tasks failed | retry | purge`

Jobs that exhausted their retries stay in the backend's failed set. These commands connect to it directly, so they work against a running app from any shell:

```bash
efc tasks failed                      # failed jobs + queue counts
efc tasks failed --name SendEmail -n 50
efc tasks failed --json               # machine-readable
efc tasks retry 1842 1843             # re-queue (one more attempt each)
efc tasks retry --all
efc tasks purge 1842                  # delete
efc tasks purge --all
```

```
  Queue waiting=0  active=1  delayed=2  completed=318  failed=1

  ✗ SendEmail #1842  attempts=4  2026-10-10T12:00:01.000Z
    SMTP connection refused
    data: {"to":"ada@example.com","subject":"Welcome"}
```

| Option | Meaning |
|---|---|
| `--backend <bullmq\|pg-boss>` | Default: BullMQ if `REDIS_URL` is set, else pg-boss for a `postgres` `DATABASE_URL` |
| `--queue <name>` | `tasks.queue` from `ignite()` (default `efc`) |
| `--redis-url <url>` | BullMQ connection (default `REDIS_URL`, from the environment or `.env`) |
| `--database-url <url>` | pg-boss connection (default `DATABASE_URL`) |

---

## `efc doctor`

Validates your project setup and reports any problems.

```bash
efc doctor
```

**Checks performed:**

| Check | What it validates |
|---|---|
| `package.json` exists | Project root has a `package.json` |
| `tsconfig.json` exists | TypeScript config is present; hint: `tsc --init` |
| `src/api` exists | Route directory is present |
| `DATABASE_URL` set | `process.env.DATABASE_URL` is non-empty |
| `JWT_SECRET` set | `process.env.JWT_SECRET` is non-empty |

**Sample passing output:**

```
  EFC Doctor

  ✓  package.json exists
  ✓  tsconfig.json exists
  ✓  src/api directory exists
  ✓  DATABASE_URL set
  ✓  JWT_SECRET set

  All checks passed!
```

**Sample failing output:**

```
  EFC Doctor

  ✓  package.json exists
  ✓  tsconfig.json exists
  ✓  src/api directory exists
  ✗  DATABASE_URL set
       → Add DATABASE_URL to .env
  ✗  JWT_SECRET set
       → Add JWT_SECRET to .env (generate: openssl rand -hex 64)

  Some checks failed. Fix the issues above.
```

Exits with code `1` if any check fails.

**Note:** `efc doctor` reads `DATABASE_URL` and `JWT_SECRET` from `process.env`. In development, source `.env` before running the command — or run it via `npm run dev` which loads `.env` automatically.

```bash
# Quick way to run doctor with .env loaded:
source .env && efc doctor
```
