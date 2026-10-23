# defineTable — API Reference

```ts
import { defineTable, type InferRecord } from 'express-file-cluster';
```

`defineTable` is EFC's **PostgreSQL-native** model API. It uses Prisma's query vocabulary
(`findMany({ where, orderBy, take, cursor })`, `findUnique`, `upsert`, `groupBy`, `aggregate`)
and SQL types (`integer`, `bigint`, `decimal`, `varchar`, native arrays and enums, serial ids).
Each call is a single parameterised SQL statement.

It shares the foundation with [`defineModel`](./db.md): the same schema format, validation,
automatic table sync, `transaction()`, errors and inferred types. Choose between them:

| | `defineModel` | `defineTable` |
|---|---|---|
| Engine | MongoDB **or** PostgreSQL | PostgreSQL only |
| Queries | MongoDB-style (`find(filter)`, `$gt`, `$inc`) | Prisma-style (`findMany({ where })`, `gt`, `increment`) |
| Types | portable set | + `integer`, `bigint`, `decimal`, `uuid`, `json`, `varchar`, native arrays/enums |
| Use it when | the app may switch engines | you're building on PostgreSQL |

On a MongoDB connection, the first call to a `defineTable` model throws an `[EFC]` error.
Calling a MongoDB-style method on a table (or a Prisma-style one on a `defineModel`) is a
compile error. A `defineModel` and a `defineTable` over the same table read and write the same
records (default naming, uuid ids), so you can move one model at a time.

---

## `defineTable(name, schema, options?)`

```ts
export const Order = defineTable(
  'Order',
  {
    number:   { type: 'string', required: true, unique: true, maxLength: 20 },   // varchar(20)
    status:   { type: 'string', enum: ['open', 'paid', 'shipped'], default: 'open', nativeEnum: true },
    total:    { type: 'decimal', precision: 10, scale: 2, required: true },      // numeric(10,2) → '19.99'
    qty:      { type: 'integer', required: true, min: 1 },                       // integer
    views:    { type: 'bigint', default: 0n },                                   // bigint → 0n
    tags:     { type: 'array', of: 'string', default: [] },                      // text[]
    shipping: { city: { type: 'string', required: true }, zip: { type: 'string' } }, // jsonb
    meta:     { type: 'json' },                                                  // jsonb, any JSON
    customer: { type: 'uuid', required: true },
  },
  { id: 'serial', naming: 'snake_case', indexes: [{ fields: { customer: 1, number: 1 }, unique: true }] },
);

export type Order = InferRecord<typeof Order>;
// { id: number; number: string; status: 'open' | 'paid' | 'shipped'; total: string; qty: number;
//   views: bigint; tags: string[]; customer: string; shipping?: { city: string; zip?: string };
//   meta?: unknown; createdAt: Date; updatedAt: Date }
```

### Field types

All the [`defineModel` field types and rules](./db.md#schema-fields) (`required`, `default`,
`enum`, `min`/`max`, `minLength`/`maxLength`, `match`, `validate`, `unique`, `index`,
`sequence`, nested objects, arrays of objects) also work here, plus:

| `type` | Column | JS value (reads) | Accepts on writes |
|---|---|---|---|
| `'integer'` | `integer` | `number` (32-bit, whole) | `number` |
| `'bigint'` | `bigint` | `bigint` | `bigint \| number` |
| `'decimal'` (`precision`, `scale`) | `numeric(p,s)` | `string`, exact | `string \| number` |
| `'uuid'` | `uuid` | `string` | `string` |
| `'json'` | `jsonb` | `unknown` | any JSON |
| `'string'` + `maxLength` | `varchar(n)` | `string` | `string` |
| `{ type: 'array', of: <scalar> }` | native array (`text[]`, `integer[]`, …) | `T[]` | `T[]` |
| `enum` + `nativeEnum: true` | PostgreSQL `ENUM` type | literal union | literal union |

Without `nativeEnum`, an `enum` is a `CHECK` constraint, as with `defineModel`. Arrays of nested
objects, embedded objects and `json` are stored as `jsonb`. `column: 'name'` sets a top-level
field's column name.

Responses from `ignite()` serialise `bigint` values as strings (`"9007199254740993"`).

### Options

```ts
interface TableOptions {
  id?: 'uuid' | 'serial' | 'bigserial';   // default 'uuid'; serial → number ids, bigserial → bigint ids
  naming?: 'snake_case';                   // createdAt → created_at, OrderItem → order_items
  timestamps?: boolean | { createdAt?: string | false; updatedAt?: string | false };
  indexes?: { fields: Record<string, 1 | -1 | 'text'>; unique?: boolean; name?: string }[];
  collection?: string;                     // table name
  relations?: Record<string, { hasMany: string; foreignKey: string } | { hasOne: string; foreignKey: string }>;  // see Include
}
```

### Schema sync

The table is created and kept in step on first use, with the same rules as `defineModel`. It
never drops columns or rows. On top of that:

- Native enum types are created, and new values are added. Values are never removed.
- `varchar` columns never shrink, and an existing `text` column is never narrowed.
- An existing `jsonb` array column (e.g. from `defineModel`) is converted to a native array,
  keeping the data.

Preview the changes with `efc db sync --dry-run`.

### Foreign keys

A top-level `ref` field is a real foreign key to the referenced model's `id`:

```ts
export const Author = defineTable('Author', { name: { type: 'string', required: true } });
export const Category = defineTable('Category', {
  name:   { type: 'string', required: true },
  parent: { type: 'integer', ref: 'Category', onDelete: 'setNull' },   // self-relation
}, { id: 'serial' });

export const Post = defineTable('Post', {
  title:    { type: 'string', required: true },
  author:   { type: 'uuid', ref: 'Author', required: true, onDelete: 'cascade' },
  reviewer: { type: 'uuid', ref: 'Author' },                            // onDelete: 'restrict'
  category: { type: 'integer', ref: 'Category' },
});
```

| `onDelete` | Deleting the referenced record… |
|---|---|
| `'restrict'` (default) | is refused with a **409** while records point at it |
| `'cascade'` | deletes the records pointing at it too |
| `'setNull'` | clears the field on those records (not allowed on `required` fields) |

- The field's `type` must match the target's id: `uuid` (or `objectId`) for `id: 'uuid'`,
  `integer` for `'serial'`, `bigint` for `'bigserial'`. A mismatch fails at first use, saying
  which type to declare.
- Writing an id that doesn't exist is a **400** on that field (`author: Author not found`).
- Ref columns get an index (`<table>_<column>_idx`) unless `index: false`.
- The referenced model must be defined (imported) before the model that references it is used.
- The value is still the id: `post.author` is a string (or number). Loading the referenced
  record with `include` comes next (M3b).

Sync creates a missing target table first, then adds the key `NOT VALID` (instant, and existing
rows can't fail the deploy) and validates it right after the commit. If old rows point at
records that no longer exist, validation is skipped with a warning naming the count. The key
still applies to new writes; fix the rows and run `efc db sync` to validate it. Changing
`onDelete` replaces the key, and removing `ref` drops it. Foreign keys on columns the model
doesn't declare are left alone.

`defineModel` keeps `ref` portable: on PostgreSQL it stays a plain column with no foreign key,
the same as on MongoDB.

### Many-to-many

An array of refs is a many-to-many relation:

```ts
export const Tag = defineTable('Tag', { label: { type: 'string', required: true, unique: true } });
export const Post = defineTable('Post', {
  title: { type: 'string', required: true },
  tags:  { type: 'array', of: 'uuid', ref: 'Tag' },          // of: matches Tag's id type
});

const post = await Post.create({ data: { title: 'Hello', tags: [news, tech] } });
post.tags;                                                   // [news, tech] — ids, in order
await Post.findMany({ where: { tags: { has: tech } } });
await Post.update({ where: { id: post.id }, data: { tags: { push: launch } } });
await Post.update({ where: { id: post.id }, data: { tags: { set: [tech] } } });
```

- Records keep the list of ids (`string[]`, `number[]` or `bigint[]`), in the order written, without
  duplicates. New records start with `[]`.
- Filters are the list filters: `has`, `hasSome`, `hasEvery`, `isEmpty`, `equals`. Updates take a
  list, `{ set: [...] }` or `{ push: id | [...] }` (ids already linked are left in place).
  `select` / `omit` work as for any field. Ordering, grouping and `_sum`-style aggregates on the
  field are refused.
- The links live in a join table, `<table>_<column>` (`posts_tags`): `owner_id`, `ref_id`,
  `position`, primary key `(owner_id, ref_id)`, an index on `ref_id`, and foreign keys to both
  tables with `ON DELETE CASCADE`. Deleting a post or a tag removes its links (a deleted tag
  disappears from every post's `tags`). There is no `onDelete` option for these fields.
- An id that doesn't exist is a **400** on the field, and nothing is written.
- Reads stay one statement (the list is a subquery). A write that changes links runs in a
  transaction: the row, then the links.
- Self-relations work (`friends: { type: 'array', of: 'uuid', ref: 'Person' }`).

**Moving from an array column.** If the table already stores the field as an array (`uuid[]`,
or `jsonb` from `defineModel`), the first sync copies it into the join table, keeping the order
and skipping values that aren't ids. The old column stays (sync never drops columns) but is no
longer read or written, so a `defineModel` over the same table won't see later changes to the
list.

### Include

`include` loads related records into the result: a `ref` field becomes the record it points at,
a many-to-many field the list of records, and back-relations — declared with `relations` —
the records pointing here.

```ts
export const User = defineTable('User', { email: { type: 'string', required: true, unique: true } }, {
  relations: {
    posts:   { hasMany: 'Post', foreignKey: 'author' },     // Post.author refs User
    profile: { hasOne: 'Profile', foreignKey: 'user' },     // Profile.user refs User, unique
  },
});
export const Tag = defineTable('Tag', { label: { type: 'string', required: true } }, {
  relations: { posts: { hasMany: 'Post', foreignKey: 'tags' } },  // through Post.tags (m:n)
});

const users = await User.findMany({
  include: {
    profile: true,
    posts: {
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { title: true },
      include: { tags: { select: { label: true } } },
    },
  },
});
// [{ id, email, …, profile: { … } | null, posts: [{ title, tags: [{ label }] }] }]

await Post.findUnique({ where: { id }, include: { author: true } });   // author: { … } | null
```

| Relation | Declared as | `include` gives |
|---|---|---|
| belongs to | `author: { type: 'uuid', ref: 'User' }` | the record, or `null` (never `null` when `required`) |
| many-to-many | `tags: { type: 'array', of: 'uuid', ref: 'Tag' }` | the records, in link order |
| has many | `relations: { posts: { hasMany: 'Post', foreignKey: 'author' } }` | the records (by `id` unless `orderBy`) |
| has one | `relations: { profile: { hasOne: 'Profile', foreignKey: 'user' } }` | the record or `null` — `foreignKey` must be `unique` |

- `true`, or options: `select`, `omit`, a nested `include` (any depth), and on lists `where`,
  `orderBy`, `take`, `skip`. `false` leaves the relation out.
- `foreignKey` names the field on the other model that refs this one: a scalar `ref` or a
  many-to-many array.
- **One statement per call**, whatever the depth: each relation is a correlated subquery
  building `jsonb`. Included records read exactly like direct reads (`bigint`s, decimals as
  strings, dates).
- `findMany`, `findFirst`, `findUnique` (and `…OrThrow`), `create`, `update`, `upsert` and
  `delete` take `include`. Writes read the record back with its relations after writing;
  `delete` reads it first.
- Self-relations work both ways (`parent` ref + `children: { hasMany: 'Category', foreignKey: 'parent' }`).

**Types.** Relations name models by string, so register your models once for typed includes:

```ts
declare module 'express-file-cluster' {
  interface Tables { User: typeof User; Post: typeof Post; Tag: typeof Tag; Profile: typeof Profile }
}
```

Included records are then typed (`select` / `omit` / nested `include` applied), and `include`
keys, nested `where` and `orderBy` are checked. A relation to an unregistered model still works,
typed as `Record<string, unknown>`.

---

## Reading

```ts
findMany(args?)            → Record[]
findFirst(args?)           → Record | null
findFirstOrThrow(args?)    → Record          // 404 HttpError if none
findUnique({ where })      → Record | null   // where must name a unique key
findUniqueOrThrow({ where }) → Record        // 404 HttpError if none
count(args?)               → number          // or { _all, field… } with select
```

```ts
const page = await Order.findMany({
  where: {
    status: { in: ['paid', 'shipped'] },
    total: { gte: '100' },
    customer: id,
    OR: [{ number: { startsWith: 'EU-' } }, { tags: { has: 'priority' } }],
  },
  orderBy: [{ createdAt: 'desc' }, { qty: { sort: 'asc', nulls: 'last' } }],
  take: 20,
  skip: 20,
  select: { id: true, number: true, total: true },   // result type narrows to these
});
```

| Argument | |
|---|---|
| `where` | filters (below) |
| `orderBy` | `{ field: 'asc' \| 'desc' }`, `{ field: { sort, nulls: 'first' \| 'last' } }`, or an array |
| `take` / `skip` | page size / offset. A negative `take` reads backwards. |
| `cursor` | a unique `where` (`{ id }`). The page starts **at** that record; add `skip: 1` to start after it. |
| `distinct` | `['field', …]`: the first record per distinct combination, in `orderBy` order |
| `select` / `omit` | `{ field: true }`: keep, or leave out, these fields. The result type follows. |

Pages are ordered deterministically: when `take`, `skip` or `cursor` is used, ties are broken
by `id`. Cursors work with any `orderBy`, including mixed directions and nullable columns.

```ts
// Cursor pagination
const next = await Order.findMany({ orderBy: { qty: 'desc' }, take: 20, cursor: { id: last }, skip: 1 });
```

### Filters

| Field kind | Filters |
|---|---|
| any scalar | a value (equality), `null`, `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte` |
| strings | + `contains`, `startsWith`, `endsWith`, `mode: 'insensitive'` (ILIKE) |
| native arrays | `has`, `hasEvery`, `hasSome`, `isEmpty`, `equals` |
| objects / arrays of objects / `json` | `equals`, `not`, and with `path: ['a', 'b']`: `equals`, `string_contains`, `string_starts_with`, `string_ends_with`, `array_contains`, `gt`… |
| relations, to-many (many-to-many fields, `hasMany`) | `some`, `every`, `none` — each a `where` on the related model |
| relations, to-one (ref fields, `hasOne`) | `is`, `isNot` — a `where` on the related model, or `null` |
| combinators | `AND`, `OR`, `NOT` (an object or an array) |

```ts
await User.findMany({ where: { posts: { some: { comments: { some: { approved: false } } } } } });
await User.findMany({ where: { posts: { none: {} } } });                    // users without posts
await Post.findMany({ where: { author: { is: { role: 'admin' } }, tags: { every: { public: true } } } });
await Post.findMany({ where: { author: { is: null } } });                   // no author
```

Relation filters are `EXISTS` subqueries — the read stays one statement — and nest to any
depth. They work wherever `where` does: reads, `count`, `include`, `updateMany`, `deleteMany`.
`every` holds for records with no related records at all. A ref or many-to-many field still
takes its own id filters (`author: id`, `tags: { has: id }`); a back-relation only these.

`undefined` values are ignored. Filters on undeclared fields match nothing, as with
`defineModel`. `LIKE` wildcards in `contains`, `startsWith` and `endsWith` are escaped.

### Unique lookups

`findUnique`, `update`, `upsert`, `delete` and `cursor` take a `where` that names one record:
`id`, a `unique: true` field, or every field of a `unique` index (e.g. `{ customer, number }`).
Other filters may be added. A `where` that isn't unique doesn't compile, and at runtime it
throws a `ModelValidationError`.

---

## Writing

```ts
create({ data, select?, omit? })                        → Record
createMany({ data: [...], skipDuplicates? })            → { count }
createManyAndReturn({ data: [...], select? })           → Record[]
update({ where: unique, data, select? })                → Record        // 404 if missing
updateMany({ where?, data })                            → { count }
updateManyAndReturn({ where?, data, select? })          → Record[]
upsert({ where: unique, create, update, select? })      → Record
delete({ where: unique })                               → Record        // 404 if missing
deleteMany({ where? })                                  → { count }
```

```ts
await Order.update({
  where: { number: 'EU-1' },
  data: {
    status: 'paid',
    qty: { increment: 1 },        // decrement, multiply, divide — number fields
    views: { increment: 1n },
    total: { decrement: '5.00' },  // exact on decimals
    tags: { push: 'priority' },    // or an array; on native arrays
    shipping: { city: 'Oslo' },    // jsonb fields take whole values
    meta: null,                     // null unsets an optional field
  },
});
```

- **`upsert`** is a single `INSERT … ON CONFLICT (<unique key>) DO UPDATE`, so it's atomic and
  race-free. Key values from `where` fill `create` when they're missing there.
- **`createMany({ skipDuplicates: true })`** → `ON CONFLICT DO NOTHING`.
- Writes are validated like `defineModel` writes: type, `enum`, bounds, `integer` range,
  `decimal` precision/scale, `maxLength` and `validate`. Failures throw `ModelValidationError`
  (400); a duplicate unique value gives a 409. `updatedAt` is refreshed on every update.
  `increment`/`decrement` results are not re-checked against `min`/`max`.

### Nested writes

`create`, `update` and `upsert` can write related records in the same call:

```ts
await Post.create({
  data: {
    title: 'Hello',
    author: { connect: { email: 'ann@x.io' } },                  // a ref: connect / create / connectOrCreate
    tags: {                                                      // many-to-many
      connect: [{ label: 'news' }],
      connectOrCreate: [{ where: { label: 'tech' }, create: { label: 'tech' } }],
      create: [{ label: 'launch' }],
    },
    comments: { create: [{ body: 'First!' }] },                  // a back-relation (hasMany)
  },
  include: { author: true, tags: true, comments: true },
});

await User.update({
  where: { id },
  data: {
    posts: { connect: [{ id: p1 }], disconnect: [{ id: p2 }], deleteMany: { draft: true } },
    profile: { create: { bio: 'hi' } },                          // hasOne: replaces the current one
  },
});
```

| Relation | `create` | `update` adds |
|---|---|---|
| ref field | `connect`, `create`, `connectOrCreate` (or the id) | `disconnect: true` |
| many-to-many field | `connect`, `create`, `connectOrCreate` (or ids) | `disconnect`, `set`, `push`, `pull` |
| `hasMany` | `connect`, `create` | `disconnect`, `set`, `delete`, `deleteMany` |
| `hasOne` | `connect`, `create` | `disconnect: true`, `delete: true` |

- `connect`, `disconnect`, `set` and `delete` take unique wheres (or ids); a list or a single one.
  A `connect` that matches nothing is a **400** on the field.
- Children created through a back-relation get their foreign key from the parent — leave it out.
- On `update`, a `hasOne` `create` / `connect` / `disconnect` first unlinks the current child (its
  foreign key is set to `null`). If that key is `required` and a child exists, it's a **400**:
  add `delete: true` (`profile: { delete: true, create: { … } }`) to replace it.
- The whole call runs in **one transaction**: anything failing rolls it all back.
- `createMany` / `updateMany` write rows only; they refuse nested writes, as in Prisma.
- `upsert` with nested writes reads first, then creates or updates, in the transaction (without
  nested writes it stays a single `INSERT … ON CONFLICT`).
- A model first used inside a transaction gets its table right away and its foreign keys once
  the transaction commits, so the sync never waits on the transaction's own locks.

---

## Aggregation

```ts
const stats = await Order.aggregate({
  where: { status: 'paid' },
  _count: true,
  _sum: { total: true, qty: true },
  _avg: { qty: true },
  _min: { createdAt: true },
  _max: { total: true },
});
// { _count: number; _sum: { total: string | null; qty: number | null }; _avg: { qty: number | null };
//   _min: { createdAt: Date | null }; _max: { total: string | null } }

const byStatus = await Order.groupBy({
  by: ['status'],
  where: { createdAt: { gte: since } },
  _count: { _all: true },
  _sum: { total: true },
  having: { total: { _sum: { gt: 1000 } } },
  orderBy: { _sum: { total: 'desc' } },
  take: 10,
});
```

| Aggregate | Applies to | Returns |
|---|---|---|
| `_count` | `true` or `{ _all, field }` | `number` (non-null values per field) |
| `_sum` | number fields | `integer`/`number` → `number`, `bigint` → `bigint`, `decimal` → `string` |
| `_avg` | number fields | `number`; `decimal` → `string` |
| `_min` / `_max` | scalar fields | the field's type |

Over an empty set, `_sum`, `_avg`, `_min` and `_max` are `null`. `aggregate` also takes
`orderBy`, `take`, `skip` and `cursor`, and then aggregates over that page.

---

## Also

- `raw()` returns the Drizzle `pgTable`, for anything EFC doesn't cover.
- `sync({ dryRun })` / `drop()` work as with `defineModel`.
- `transaction(async () => …)` covers `defineTable` calls too.
- Relations are complete: foreign keys, many-to-many, `include`, relation filters and nested
  writes (above).
