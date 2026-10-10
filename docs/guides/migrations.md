# Migrations & Seeds

`efc db` manages your schema and fixture data on both MongoDB and PostgreSQL.

| Command | Does |
|---|---|
| `efc db migrate` | Runs pending migrations in `src/migrations/` as one new batch |
| `efc db rollback [--steps n]` | Reverts the last batch (or `n` batches), newest first |
| `efc db status` | Lists applied (with batch) and pending migrations |
| `efc db seed [name]` | Runs every seed in `src/seeds/`, or just one |
| `efc db studio [-p 4983]` | Opens a read-only database browser on `127.0.0.1` |

All of them read `DATABASE_URL` from the environment or `.env` (override with `--database-url`); the engine follows the URL scheme.

---

## Writing a migration

```bash
efc generate migration add_orders
# → src/migrations/20261010120000_add_orders.ts
```

```ts
import type { MigrationContext } from 'express-file-cluster';
import { Order } from '../model/Order.js';

export async function up({ db, engine }: MigrationContext): Promise<void> {
  await Order.sync();
}

export async function down({ db, engine }: MigrationContext): Promise<void> {
  await Order.drop();
}
```

- Files run in **filename order**; the generator's UTC timestamp prefix keeps that chronological.
- `db` is the native client — a mongoose `Connection` or a node-postgres `Pool` — for anything models don't cover (`db.query('ALTER TABLE …')`).
- `Model.sync()` creates the table/collection, adds columns for new fields (nullable, never altering existing ones) and builds indexes. It never drops data, so it's safe to call from several migrations.
- `Model.drop()` removes the table/collection — for `down()`.

Projects created with `create-efc-app` include `src/migrations/00000000000000_init` that syncs every generated model. Run `efc db migrate` before the first `efc start dev` (required on PostgreSQL, where tables must exist; on MongoDB it builds the unique indexes).

---

## Batches and rollback

Applied migrations are recorded in `efc_migrations` (a table or collection) with a batch number. Everything one `migrate` run applies shares a batch, and `rollback` undoes exactly that unit:

```
efc db migrate     # applies 0001, 0002 → batch 1
efc db migrate     # applies 0003       → batch 2
efc db rollback    # reverts 0003
efc db rollback    # reverts 0002, then 0001
```

A migration that throws stops the run with exit code 1 and is **not** recorded, so the next `migrate` retries it. Earlier migrations in the same run stay applied — make migrations idempotent where you can (`sync()` already is).

On PostgreSQL, `migrate` and `rollback` take an advisory lock, so several instances running migrations at deploy time serialise instead of racing.

---

## Seeds

```bash
efc generate seed demo_users
# → src/seeds/demo_users.ts
```

```ts
import { User } from '../model/User.js';

export default async function seed() {
  await User.createMany([{ name: 'Ada', email: 'ada@example.com', password: '…' }]);
}
```

`efc db seed` runs all seeds in filename order; `efc db seed demo_users` runs one. Seeds aren't tracked — they run every time.

---

## TypeScript and production

The commands run your files in a child process: under `tsx` against `src/` when `tsx` is installed (development), otherwise with plain `node` against the compiled `dist/src/` — production images ship without devDependencies. Force the compiled files with `--dist`.

```dockerfile
# Run migrations as a release step, before starting the new version
CMD ["sh", "-c", "npx efc db migrate --dist && npx efc start prod"]
```

`EFC_DEBUG=1` prints the full stack when a migration or seed fails.

---

## Studio

`efc db studio` serves a read-only browser at `http://127.0.0.1:4983`: every table/collection with its row count, paginated rows, and expandable JSON cells. It binds to localhost only and rejects anything but `GET`.
