# Database — API Reference

```ts
import { defineModel, transaction, db, ModelValidationError } from 'express-file-cluster';
import type { InferRecord, InferCreate } from 'express-file-cluster';
```

`defineModel` gives one model API on **MongoDB** (mongoose) and **PostgreSQL** (Drizzle). The model compiles for whichever engine Pre-Flight connected — `database` in `ignite()`, or the `DATABASE_URL` scheme — the first time it is used, so models can be defined at import time. One conformance test suite runs every feature below against both engines.

---

## `defineModel(name, schema, options?)`

```ts
function defineModel(name: string, schema: ModelSchema, options?: ModelOptions): ModelCRUD<Record, CreateInput>
// record and create-input types are inferred from the schema literal
```

| Parameter | Description |
|---|---|
| `name` | Model name. Also the `ref` target for references. The collection/table defaults to its lowercase plural (`User` → `users`, `Category` → `categories`). |
| `schema` | Field definitions (below). |
| `options` | Timestamps, indexes, collection/table name. |

```ts
import { defineModel, type InferRecord } from 'express-file-cluster';

export const Order = defineModel(
  'Order',
  {
    number:   { type: 'number', sequence: true },
    status:   { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending', index: true },
    customer: { type: 'objectId', ref: 'Customer', required: true },
    items:    [{ sku: { type: 'string', required: true }, qty: { type: 'number', min: 1 } }],
    shipping: { city: { type: 'string', required: true }, zip: { type: 'string', match: /^\d{5}$/ } },
    tags:     { type: 'array', of: 'string', default: [] },
  },
  { indexes: [{ fields: { customer: 1, createdAt: -1 } }] },
);

export type Order = InferRecord<typeof Order>;
// {
//   id: string; number: number; status: 'pending' | 'paid' | 'shipped'; customer: string;
//   tags: string[]; items?: { sku: string; qty?: number }[];
//   shipping?: { city: string; zip?: string }; createdAt: Date; updatedAt: Date;
// }
```

### Inferred types

No interface to write or keep in step: `defineModel` reads the schema literal.

| Schema | Record type (`InferRecord<typeof M>`) | `create()` input (`InferCreate<typeof M>`) |
|---|---|---|
| `'string'` / `'number'` / `'boolean'` | `string` / `number` / `boolean` | same |
| `'date'` | `Date` (also inside embedded objects/arrays, on both engines) | `Date \| string \| number` |
| `'objectId'` | `string` | `string` |
| `enum: [...]` | union of the literals | same |
| `{ type: 'array', of }`, `[schema]` | `X[]` | `X[]` |
| nested schema / `{ type: 'object', fields }` | object, inferred recursively | same, with create rules |
| `{ type: 'object' }` / `{ type: 'array' }` without `of`/`fields` | `unknown` / `unknown[]` | same |
| `required`, `default` or `sequence` | non-optional | mandatory only if `required` without `default`/`sequence` |
| anything else | optional (`?`) | optional |

Timestamps follow `options.timestamps` (`createdAt`/`updatedAt: Date`, renamed or left out). Filters, updates, `distinct()` fields and return values are all typed from the record; an undeclared field or a value outside an `enum` is a compile error.

The explicit form still works and keeps the v0.4 behaviour (`create()` takes `Partial<T>`):

```ts
interface Legacy { title: string; pages?: number }
const Book = defineModel<Legacy>('Book', { title: { type: 'string' }, pages: { type: 'number' } });
```

A schema stored in a variable annotated as `ModelSchema` has nothing to infer from — declare it inline (or `as const satisfies ModelSchema`) to get the types.

---

## Schema fields

A field is one of:

| Form | Example | Meaning |
|---|---|---|
| `FieldDefinition` | `{ type: 'string', required: true }` | A typed field |
| Nested schema (shorthand) | `shipping: { city: { type: 'string' } }` | Embedded object with typed, validated fields |
| `{ type: 'object', fields }` | `{ type: 'object', required: true, fields: { … } }` | Embedded object that can itself be `required` |
| `[schema]` | `items: [{ sku: { type: 'string' } }]` | Array of embedded documents |
| `{ type: 'array', of }` | `{ type: 'array', of: 'string' }` / `of: { … }` | Typed array of primitives or embedded documents |

Inner `required` fields of an embedded object only apply when the object is present.

### `FieldDefinition`

| Option | Applies to | Description |
|---|---|---|
| `type` | all | `'string' \| 'number' \| 'boolean' \| 'date' \| 'objectId' \| 'object' \| 'array'` |
| `required` | all | Rejects missing (and explicitly `null`) values |
| `unique` | all | Unique index; duplicates throw `HttpError(409)` |
| `index` | all | Single-field index |
| `default` | all | Literal, function, or an operator code (below) |
| `enum` | string, number | Allowed values |
| `min` / `max` | number, date | Inclusive bounds |
| `minLength` / `maxLength` | string | Inclusive length bounds |
| `match` | string | `RegExp` the value must match |
| `validate` | all | `(value) => true \| false \| 'message'` — may be async |
| `ref` | objectId, objectId arrays | Model name, enables `populate` |
| `of` | array | Item type: a primitive name or a nested schema |
| `fields` | object | Typed fields of an embedded object |
| `sequence` | number | Auto-increment (below) |
| `renamedFrom` | any (top-level) | The field's previous name: PostgreSQL sync renames the column (keeping the data); on MongoDB `efc db generate` writes a `$rename` migration |

`type: 'object'` without `fields` (and `array` without `of`) store any JSON value unvalidated.

**Types per engine.** `objectId` is a mongoose `ObjectId` on MongoDB and a `uuid` on PostgreSQL (ids are UUIDs there). On PostgreSQL, embedded objects and arrays are `jsonb` columns, `date` is `timestamptz`, `number` is `double precision` (`bigint` for sequences).

### Default operator codes

| Code | Resolves to (per record) | Pair with |
|---|---|---|
| `'$now'` | `new Date()` | `date` |
| `'$uuid'` | `crypto.randomUUID()` | `string` |
| `'$objectId'` | a fresh id (ObjectId / UUID) | `objectId` |
| `'$timestamp'` | `Date.now()` | `number` |
| `'$shortId'` | 16-char base64url string | `string` |
| `'$currentUser'` | the request's JWT payload (`getCurrentUser()`) | `object` |
| `'$currentUser.<key>'` | one field of it, e.g. `'$currentUser.id'` | that field's type |

`$currentUser` codes resolve to `undefined` outside a request or without `requireAuth` — they never throw. Any other value is used literally.

### Sequence fields

```ts
orderNumber: { type: 'number', sequence: true, required: true }
```

`sequence: true` keys the counter `'<Model>.<field>'`; a string shares one counter across fields/models. Values are assigned on insert, before `required` runs, and only when not supplied. MongoDB keeps counters in `efc_counters` (atomic `$inc` + upsert); PostgreSQL uses a real `SEQUENCE` (`efc_seq_<key>`). Top-level fields only.

---

## `ModelOptions`

```ts
interface ModelOptions {
  timestamps?: boolean | { createdAt?: string | false; updatedAt?: string | false }; // default true
  indexes?: IndexDefinition[];
  collection?: string; // collection (MongoDB) or table (PostgreSQL) name
}

interface IndexDefinition {
  fields: Record<string, 1 | -1 | 'text'>;
  unique?: boolean;
  expireAfterSeconds?: number; // MongoDB TTL index only
  name?: string;
}
```

Indexes (including `unique`/`index` field options) are created by [`Model.sync()`](#syncmigrations) — automatically on first use unless `autoSync: false`. Text indexes use MongoDB text search or a PostgreSQL GIN `to_tsvector('simple', …)` index; TTL indexes are MongoDB-only and `sync()` rejects them on PostgreSQL.

---

## `ModelCRUD<T>`

Every record has a string `id` (MongoDB records also keep `_id`). Unset fields are absent from records on both engines.

### Reading

```ts
find(filter?: Filter<T>, options?: FindOptions): Promise<ModelRecord<T>[]>
findOne(filter: Filter<T>, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>
findById(id: string, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>
count(filter?: Filter<T>): Promise<number>
exists(filter: Filter<T>): Promise<boolean>
distinct(field: ScalarKeys<T>, filter?: Filter<T>): Promise<T[field][]>
```

`distinct()` returns the non-null values of a scalar field (or `id`, `createdAt`, …) among matching records, de-duplicated and sorted ascending. Array and object fields are rejected — the two engines disagree on what "distinct" means for them.

```ts
interface FindOptions {
  populate?: string | string[];               // resolve `ref` fields into records
  select?: string[];                          // only these fields (id always included)
  sort?: Record<string, 1 | -1 | 'asc' | 'desc'>;
  limit?: number;
  skip?: number;
}
```

```ts
const page = await Order.find(
  { status: { $in: ['paid', 'shipped'] }, 'shipping.city': 'Oslo' },
  { sort: { createdAt: -1 }, skip: 20, limit: 20, select: ['number', 'status'], populate: 'customer' },
);
```

`findById` with a malformed id returns `null`, like an unknown one.

### Filters

| Filter | Matches |
|---|---|
| `{ status: 'paid' }` | equality (`null` matches missing/null) |
| `{ tags: 'sale' }` | array field **contains** the value |
| `{ total: { $gte: 10, $lt: 100 } }` | `$eq $ne $gt $gte $lt $lte` |
| `{ status: { $in: [...] } }` | `$in`, `$nin` |
| `{ coupon: { $exists: false } }` | field present / absent |
| `{ title: { $regex: /^intro/i } }` | regular expression |
| `{ 'shipping.city': 'Oslo' }` | dotted path into an embedded object |
| `{ $or: [{…}, {…}] }`, `$and` | combinations |
| `{ id: { $in: ids } }` | primary key |

This subset behaves identically on both engines and is typed (`Filter<T>`) — no casts needed. Other MongoDB operators pass through on MongoDB and are rejected with a `ModelValidationError` on PostgreSQL.

### Writing

```ts
create(data: CreateInput): Promise<ModelRecord<T>>
createMany(data: CreateInput[]): Promise<ModelRecord<T>[]>
update(id: string, data: Update<T>): Promise<ModelRecord<T> | null>       // returns the updated record
updateOne(filter: Filter<T>, data: Update<T>): Promise<ModelRecord<T> | null>
updateMany(filter: Filter<T>, data: Update<T>): Promise<number>          // records modified
upsert(filter: Filter<T>, create: CreateInput, update: Update<T>): Promise<ModelRecord<T>>
delete(id: string): Promise<void>
deleteOne(filter: Filter<T>): Promise<ModelRecord<T> | null>             // returns the deleted record
deleteMany(filter: Filter<T>): Promise<number>                           // records deleted
```

- `updateOne` / `deleteOne` act on the first matching record in **one statement** (`findOneAndUpdate` / `UPDATE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE)`) and return it, or `null` if nothing matched. Which record is "first" is unspecified when several match.
- `upsert` applies `update` to the first match, or creates `create` if there is none, and returns the record. `create` is used as given — `filter` fields are not copied into it. Put a `unique` index on the filtered field(s) to make concurrent upserts safe: a duplicate on create (409) is retried once as an update.

```ts
await Order.upsert({ number: 42 }, { number: 42, customer }, { $set: { status: 'paid' } });
const next = await Order.updateOne({ status: 'pending' }, { status: 'paid' });
const statuses = await Order.distinct('status', { customer });   // ('pending' | 'paid' | 'shipped')[]
if (await Order.exists({ customer, status: 'pending' })) { /* … */ }
```

`Update<T>` is plain fields (shorthand for `$set`) and/or operators:

```ts
await Order.update(id, { status: 'paid' });
await Order.update(id, {
  $set: { 'shipping.zip': '01234' },
  $inc: { attempts: 1 },
  $push: { tags: 'priority' },          // or { $each: ['a', 'b'] }
  $pull: { tags: 'draft' },
  $unset: { coupon: true },
});
```

**Updates are validated**: changed fields must satisfy their type, `enum`, bounds, `match` and custom `validate`, and a `required` field can't be unset or nulled. `updatedAt` is refreshed.

### Engine-specific

```ts
aggregate<R>(pipeline: object[]): Promise<R[]>   // MongoDB only — rejects on PostgreSQL
raw(): Promise<unknown>                            // mongoose Model / Drizzle pgTable
```

`raw()` hands you the native object for anything the shared surface doesn't cover — e.g. Drizzle joins on PostgreSQL:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { getDbClient } from 'express-file-cluster';
import type { Pool } from 'pg';

const orm = drizzle(getDbClient() as unknown as Pool); // the real pool, not the `db` proxy
const orders = (await Order.raw()) as any;
const customers = (await Customer.raw()) as any;
const rows = await orm.select().from(orders).innerJoin(customers, eq(orders.customer, customers.id));
```

### `sync()` / `drop()` {#syncmigrations}

```ts
sync(options?: { dryRun?: boolean }): Promise<string[]>
drop(): Promise<void>   // drop the collection/table and its data
```

`sync()` reconciles the database with the model and returns the changes it made — with `dryRun`, the changes it *would* make, applying nothing. On PostgreSQL those are SQL statements, run in one transaction under an advisory lock (concurrent syncs from several workers are safe): create the table, add columns, convert changed column types, drop stale `NOT NULL`s, rebuild enum checks, create declared indexes and drop EFC-created ones the model no longer declares. It never drops a column or a row. On MongoDB it creates the collection and syncs indexes.

It runs automatically the first time a model is used in a process (`autoSync`, default on). Call it yourself from [migrations](../guides/migrations.md), or use `efc db sync [--dry-run]` for every model in `src/model(s)/`.

### Undeclared fields

Same on both engines (mongoose's defaults): ignored on `create`/`update`, treated as absent in filters — `{ x: null }`, `{ x: { $exists: false } }`, `{ x: { $ne: … } }` match every record, other conditions match none — and ignored in `sort` and `select`.

---

## Errors

| Situation | Thrown | HTTP (via the global handler) |
|---|---|---|
| Validation failure (create/update) | `ModelValidationError` | `400` with `issues: [{ path, message }]` |
| Duplicate value of a `unique` field | `HttpError` | `409` — `"Order with this number already exists"` |
| Unsupported operator (PostgreSQL) | `ModelValidationError` | `400` |
| Table missing with `autoSync: false` (PostgreSQL) | `Error` naming the table | `500` |

```ts
import { ModelValidationError } from 'express-file-cluster';

try {
  await User.create(input);
} catch (err) {
  if (err instanceof ModelValidationError) console.log(err.issues); // [{ path: 'email', message: 'is required' }]
  throw err;
}
```

---

## `transaction(fn)`

```ts
function transaction<T>(fn: () => Promise<T>): Promise<T>
```

Every model call inside `fn` — however deeply nested — joins the transaction automatically; a throw rolls everything back. Nested calls reuse the outer transaction.

```ts
import { transaction } from 'express-file-cluster';

await transaction(async () => {
  const order = await Order.create({ customer: customerId, items });
  await Stock.updateMany({ sku: { $in: items.map((i) => i.sku) } }, { $inc: { count: -1 } });
  return order;
});
```

MongoDB transactions require a replica set (Atlas, or `mongod --replSet`).

---

## `db` — native client

`db` forwards to the live client from Pre-Flight: a mongoose `Connection` on MongoDB, a node-postgres `Pool` on PostgreSQL.

```ts
import { db } from 'express-file-cluster';

// MongoDB
const stats = await db.model('User').aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);

// PostgreSQL
const { rows } = await db.query('SELECT role, count(*) FROM users GROUP BY role');
```

It throws if accessed before Pre-Flight completes (e.g. at module load time) — use it inside handlers, tasks and migrations.

### `getDbClient()` / `setDbClient()`

Read or replace the client behind `db` — mainly for tests that bypass `ignite()`.
