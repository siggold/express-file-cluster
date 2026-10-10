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
import { defineModel } from 'express-file-cluster';

export interface Post {
  title: string;
  slug: string;
  status: 'draft' | 'published';
  author: string;
  seo: { description?: string; keywords: string[] };
  revisions: { body: string; at: Date }[];
}

export const Post = defineModel<Post>('Post', {
  title:     { type: 'string', required: true, minLength: 3, maxLength: 120 },
  slug:      { type: 'string', required: true, unique: true, match: /^[a-z0-9-]+$/ },
  status:    { type: 'string', enum: ['draft', 'published'], default: 'draft', index: true },
  author:    { type: 'objectId', ref: 'User', required: true, default: '$currentUser.id' },
  seo:       { description: { type: 'string', maxLength: 160 }, keywords: { type: 'array', of: 'string' } },
  revisions: [{ body: { type: 'string', required: true }, at: { type: 'date', default: '$now' } }],
});
```

Full field reference: [Database API](../api-reference/db.md).

---

## Creating the schema

Tables (PostgreSQL) and indexes (both engines) are created by `Model.sync()`, run from a migration:

```ts
// src/migrations/20261010120000_posts.ts
import { Post } from '../model/Post.js';

export async function up() { await Post.sync(); }
export async function down() { await Post.drop(); }
```

```bash
efc db migrate
```

Projects from `create-efc-app` ship an init migration for every generated model. See [Migrations & Seeds](./migrations.md).

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
