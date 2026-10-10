# `efc start` / `efc build` / `efc run`

## `efc start dev`

Starts the development server.

```bash
efc start dev
```

**Behaviour:**

- Reads `.env` from the project root and injects variables into `process.env`. Variables already present in the environment take precedence.
- Defaults `NODE_ENV` to `'development'`. A `NODE_ENV` value in `.env` or in the parent environment overrides this default.
- Locates the entry point by checking these paths in order:
  1. `src/index.ts`
  2. `index.ts`
  3. `src/index.js`
  4. `index.js`
- Launches the entry point via `tsx watch --include src <entry>` for hot-reload on every file change inside `src/`.
- **Clustering is off in development** — `ignite()` defaults `cluster` to `false` when `NODE_ENV !== 'production'`. This gives fast restarts and clean stack traces.

**Requires:** `tsx` installed (either as a project dependency in `node_modules/.bin/tsx`, or globally on `PATH`).

---

## `efc start prod`

Starts the production server from compiled output.

```bash
efc start prod
```

**Behaviour:**

- Looks for `dist/src/index.js` (the `efc build prod` layout), then `dist/index.js` (a custom `tsup.config`). If neither exists, prints an error instructing you to run `efc build prod` first.
- Sets `NODE_ENV=production`.
- Does **not** read `.env` — secrets must come from the platform's environment.
- Spawns `node dist/src/index.js`.
- Forwards `SIGTERM`/`SIGINT` to the server so `gracefulShutdown()` runs, and exits with the server's exit code.
- With `NODE_ENV=production`, `ignite()` defaults `cluster` to `true` and forks `os.cpus().length` workers. When the primary receives `SIGTERM` it relays it to every worker, waits for them to drain, then exits.

---

## `efc build prod`

Compiles the project to JavaScript in `dist/`.

```bash
efc build prod
```

**Behaviour:**

- Type-checks with `tsc --noEmit` when a `tsconfig.json` exists (skipped for JavaScript projects).
- Transpiles **every** file under `src/` plus `efc.config.ts` with `tsup`, one output file per source file, keeping the directory tree:

  ```
  src/index.ts            → dist/src/index.js
  src/api/users/[id].ts   → dist/src/api/users/[id].js
  src/tasks/SendEmail.ts  → dist/src/tasks/SendEmail.js
  efc.config.ts           → dist/efc.config.js
  ```

  Files are not bundled: routes and tasks are discovered by scanning the filesystem at runtime, so each one must exist in `dist/` as its own file. Test files (`*.test.*`, `__tests__/`) are skipped.
- Output format follows `package.json` `"type"` — ESM for `"module"`, CommonJS otherwise.
- If the project has its own `tsup.config.*`, that config is used instead.

**Requires:** `tsup` installed as a dev dependency.

---

## `efc run tests`

Runs the test suite.

```bash
efc run tests
```

**Behaviour:**

- Invokes Vitest.
- Pass Vitest flags through directly:

```bash
efc run tests --watch
efc run tests --coverage
efc run tests --reporter=verbose
```

**Requires:** `vitest` installed as a dev dependency.

---

## `package.json` lifecycle scripts

The scaffolder wires these scripts automatically:

```json
{
  "scripts": {
    "dev":   "efc start dev",
    "build": "efc build prod",
    "start": "efc start prod",
    "test":  "efc run tests"
  }
}
```

Use `npm run dev`, `npm run build`, `npm start`, and `npm test` as shorthand.
