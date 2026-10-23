# `efc db`

Database migrations, seeds and studio. Works on MongoDB and PostgreSQL — the engine follows the `DATABASE_URL` scheme. Full guide: [Migrations & Seeds](../guides/migrations.md).

```bash
efc db generate <name>         # write a migration: models vs. what src/migrations produce
efc db generate --verify       # fail if the migrations miss anything the models declare
efc db sync [--dry-run]        # reconcile tables/collections + indexes with src/model(s)/
efc db sync --dry-run --exit-code   # exit 2 when the database has drifted from the models
efc db migrate [--baseline]    # run pending migrations (one new batch); --baseline only records them
efc db pull [--out src/model]  # write defineTable models for the database (PostgreSQL)
efc db rollback [--steps 2]    # revert the last batch(es)
efc db status                  # applied vs pending
efc db seed [name]             # run all seeds, or one
efc db studio [--port 4983]    # read-only browser on 127.0.0.1 (rows + table structure)
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

## `efc db generate` options

| Option | Meaning |
|---|---|
| `[name]` | Write the migration as `src/migrations/<UTC timestamp>_<name>.(ts\|js)`; without it, print the plan |
| `--allow-drop` | Also drop columns the models no longer declare |
| `--tighten` | Add `NOT NULL` for required fields and validate enum checks, each behind a row check |
| `--verify` | Replay every migration into a throwaway schema and exit `1` if the models need more |

`generate` connects to `DATABASE_URL`'s server but works in a temporary schema (PostgreSQL) or database (MongoDB), dropped afterwards; your data isn't read or changed.

## `efc import-prisma`

```bash
efc import-prisma [prisma/schema.prisma] [--out src/model] [--force]
```

Writes `defineTable` models from a Prisma schema (PostgreSQL). See [Coming from Prisma](../guides/coming-from-prisma.md).

## Exit codes

`0` on success, `1` on any failure (connection, a throwing migration/seed, missing `down()` on rollback, `generate --verify` finding missing steps). `efc db sync --dry-run --exit-code` exits `2` when there are pending changes. Set `EFC_DEBUG=1` for stack traces.

## Scaffolding

```bash
efc generate migration <name>   # src/migrations/<UTC timestamp>_<name>.ts
efc generate seed <name>        # src/seeds/<name>.ts
```
