# Database Guide

EFC supports **MongoDB** (via mongoose) and **PostgreSQL** (via Drizzle) behind one model API. Application code — `defineModel`, filters, updates, transactions — is the same on both; only `DATABASE_URL` and the installed driver differ.

---

## Choosing an engine

`ignite()` picks the engine from `database`, or from the `DATABASE_URL` scheme when `database` is omitted:

```
mongodb://…  mongodb+srv://…   → 'mongodb'
postgres://…  postgresql://…   → 'postgresql'
```

| | MongoDB | PostgreSQL |
|---|---|---|
| Install | `npm install mongoose` | `npm install pg drizzle-orm` |
| `DATABASE_URL` | `mongodb://user:pass@host:27017/db` | `postgres://user:pass@host:5432/db` |
| Record ids | `ObjectId` strings | UUIDs |
| Embedded objects / arrays | subdocuments | `jsonb` columns |
| Sequences | `efc_counters` collection | `SEQUENCE` |
| `db` client | mongoose `Connection` | node-postgres `Pool` |
| Transactions | need a replica set | always available |
| `aggregate()` | ✓ | use `db.query()` / Drizzle via `raw()` |
| TTL indexes | ✓ | — |

```ts
// efc.config.ts — ignite() never reads process.env itself
const config: EFCConfig = {
  databaseUrl: process.env.DATABASE_URL,
  // database: 'postgresql', // optional — inferred from the URL
};
```

Each worker process connects once during Pre-Flight, before routes mount — no cold connection on the first request.

---

## Defining models

```ts
// src/model/Post.ts
import { defineModel, type InferRecord } from 'express-file-cluster';

export const Post = defineModel('Post', {
  title:     { type: 'string', required: true, minLength: 3, maxLength: 120 },
  slug:      { type: 'string', required: true, unique: true, match: /^[a-z0-9-]+$/ },
  status:    { type: 'string', enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  author:    { type: 'objectId', ref: 'User', required: true, default: '$currentUser.id' },
  seo:       { description: { type: 'string', maxLength: 160 }, keywords: { type: 'array', of: 'string' } },
  revisions: [{ body: { type: 'string', required: true }, at: { type: 'date', default: '$now' } }],
});

export type Post = InferRecord<typeof Post>;
```

The types come from the schema — no interface to write. `Post.create()` requires `title` and `slug` (required, no default), `status` is `'draft' | 'published' | 'archived'`, and every record has `id`, `createdAt` and `updatedAt`. A typo in a field name or an enum value is a compile error.

Full field reference: [Database API](../api-reference/db.md).

---

## The schema takes care of itself

On both engines you just define the model and use it. The first time a model is used in a process, EFC reconciles its table (PostgreSQL) or collection and indexes (MongoDB) with the definition — the way mongoose has always created collections and indexes for you.

Editing a model later works the same on both engines:

| You change… | MongoDB | PostgreSQL (what sync does) |
|---|---|---|
| Add a field | new documents have it | `ADD COLUMN` |
| Remove a field | old documents keep it, it's ignored | the column stays (no data loss), it's ignored |
| Rename a field (`renamedFrom: 'old'`) | old documents keep the old name until a migration (`efc db generate`) moves it | `RENAME COLUMN` — the data comes along |
| Make a field optional / drop `required` | works | relaxes any `NOT NULL` |
| Add or remove `enum` values | works | rebuilds the enum `CHECK` (existing rows aren't re-checked) |
| Change a field's `type` | new writes use it | `ALTER COLUMN … TYPE … USING <cast>` — fails clearly if existing data can't convert |
| Add / remove `unique`, `index`, `indexes` | indexes synced | indexes created / EFC-created ones dropped |

On MongoDB the first query also waits for the collection's indexes, so `unique` is enforced from the very first write. If an index can't be built (e.g. duplicates are already stored) EFC logs a warning and the model keeps working without it — fix the data and run `efc db sync`.

Required fields, enums, bounds and custom validators are enforced by the model on writes, as on MongoDB. Columns and rows are never dropped by sync. To drop columns, or to enforce `NOT NULL` in the database too, generate a migration: `efc db generate <name> --allow-drop --tighten`.

Fields the model doesn't declare behave like mongoose's defaults on both engines: ignored on writes, treated as absent in filters (`{ legacy: null }` and `{ legacy: { $exists: false } }` match), ignored in `sort`/`select`.

**Seeing and controlling it:**

```bash
efc db sync --dry-run   # show exactly what would change (SQL on PostgreSQL)
efc db sync             # apply it now
efc db studio           # browse rows and each table's structure
```

Prefer every schema change to go through review? Set `autoSync: false` in `ignite()`. Then `efc db generate <name>` writes each change as a migration, and `efc db generate --verify` in CI checks that none is missing. See [Migrations & Seeds](./migrations.md).

---

## Querying

```ts
// Published posts tagged "node", newest first, second page
const posts = await Post.find(
  { status: 'published', 'seo.keywords': 'node' },
  { sort: { createdAt: -1 }, skip: 20, limit: 20, populate: 'author' },
);

const total = await Post.count({ status: 'published' });
const recent = await Post.find({ createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } });
const either = await Post.find({ $or: [{ status: 'draft' }, { title: { $regex: /wip/i } }] });
```

Filters, sorting and pagination behave the same on both engines.

---

## Writing

```ts
const post = await Post.create({ title: 'Hello', slug: 'hello', seo: { keywords: ['intro'] } });

await Post.update(post.id, { status: 'published' });
await Post.update(post.id, { $push: { revisions: { body: 'v2' } }, $set: { 'seo.description': 'First post' } });

const archived = await Post.updateMany({ status: 'draft', createdAt: { $lt: cutoff } }, { $set: { status: 'archived' } });
const removed = await Post.deleteMany({ status: 'archived' });

// One record by filter, in one statement
const claimed = await Post.updateOne({ status: 'draft' }, { status: 'published' });
await Post.deleteOne({ slug: 'hello' });

// Insert-or-update (put a unique index on the filtered field)
await Post.upsert({ slug: 'about' }, { title: 'About', slug: 'about' }, { $set: { title: 'About' } });

if (await Post.exists({ slug })) throw new HttpError(409, 'Slug taken');
const statuses = await Post.distinct('status');   // ('draft' | 'published' | 'archived')[]
```

Every write is validated — including updates. Invalid data throws `ModelValidationError`, which the global error handler turns into a **400** with field `issues`; a duplicate `unique` value becomes a **409**. Route handlers usually don't need to catch either.

---

## Transactions

```ts
import { transaction } from 'express-file-cluster';

await transaction(async () => {
  const order = await Order.create({ total: 40 });
  await Wallet.update(walletId, { $inc: { balance: -40 } });
  await Ledger.create({ order: order.id, amount: -40 });
});
```

Model calls inside join the transaction through `AsyncLocalStorage` — no session or `tx` objects to pass around. On MongoDB this needs a replica set.

---

## PostgreSQL-native: `defineTable`

Building on PostgreSQL only? `defineTable` gives you Prisma's query vocabulary and SQL types,
on the same foundation (schema format, validation, auto-sync, `transaction()`, inferred types):

```ts
import { defineTable } from 'express-file-cluster';

export const Order = defineTable('Order', {
  number: { type: 'string', required: true, unique: true, maxLength: 20 },
  status: { type: 'string', enum: ['open', 'paid'], default: 'open', nativeEnum: true },
  total:  { type: 'decimal', precision: 10, scale: 2, required: true },   // '19.99', exact
  qty:    { type: 'integer', required: true },
  tags:   { type: 'array', of: 'string', default: [] },                    // text[]
}, { id: 'serial', naming: 'snake_case' });

const page = await Order.findMany({
  where: { status: 'paid', total: { gte: '100' }, tags: { has: 'priority' } },
  orderBy: { createdAt: 'desc' },
  take: 20, cursor: { id: lastId }, skip: 1,
  select: { id: true, number: true, total: true },
});
await Order.upsert({ where: { number }, create: { number, total: '0', qty: 1 }, update: { qty: { increment: 1 } } });
const revenue = await Order.groupBy({ by: ['status'], _sum: { total: true }, orderBy: { _sum: { total: 'desc' } } });
```

`defineModel` and `defineTable` can share a table, so you can move models over one at a time.
Full reference: [defineTable API](../api-reference/table.md).

---

## Beyond the model API

```ts
import { db } from 'express-file-cluster';

// MongoDB — aggregation
const byRole = await User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);

// PostgreSQL — SQL on the pool
const { rows } = await db.query('SELECT date_trunc($1, "createdAt") d, count(*) FROM posts GROUP BY d', ['day']);

// Either — the native model/table
const PostModel = await Post.raw(); // mongoose Model or Drizzle pgTable
```

---

## Models in tasks and migrations

Models work the same in task handlers, migrations and seeds:

```ts
// src/tasks/PurgeSessions.ts
import { defineTask } from 'express-file-cluster/tasks';
import { Session } from '../model/Session.js';

export default defineTask({ schedule: '0 * * * *' }, async () => {
  await Session.deleteMany({ expiresAt: { $lt: new Date() } });
});
```
