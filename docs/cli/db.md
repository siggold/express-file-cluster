# `efc db`

Database migrations, seeds and studio. Works on MongoDB and PostgreSQL — the engine follows the `DATABASE_URL` scheme. Full guide: [Migrations & Seeds](../guides/migrations.md).

```bash
efc db migrate                 # run pending migrations (one new batch)
efc db rollback [--steps 2]    # revert the last batch(es)
efc db status                  # applied vs pending
efc db seed [name]             # run all seeds, or one
efc db studio [--port 4983]    # read-only browser on 127.0.0.1
```

## Common options

| Option | Meaning |
|---|---|
| `--database-url <url>` | Override `DATABASE_URL` (otherwise read from the environment, then `.env`) |
| `--dist` | Load compiled files from `dist/src/` even when `tsx` is installed |

## Where files load from

| Situation | Runs | From |
|---|---|---|
| `tsx` installed (dev) | `tsx` | `src/migrations`, `src/seeds` |
| No `tsx` (production image) | `node` | `dist/src/migrations`, `dist/src/seeds` |
| JavaScript project | `node` | `src/` |

## Exit codes

`0` on success, `1` on any failure (connection, a throwing migration/seed, missing `down()` on rollback). Set `EFC_DEBUG=1` for stack traces.

## Scaffolding

```bash
efc generate migration <name>   # src/migrations/<UTC timestamp>_<name>.ts
efc generate seed <name>        # src/seeds/<name>.ts
```
