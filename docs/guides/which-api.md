# Which model API?

EFC has two ways to define a model. They share one foundation: the schema format, inferred types, validation, auto-sync, `transaction()`, undeclared-field rules and errors. They differ in which engines they run on and in their query vocabulary.

| | `defineModel` | `defineTable` |
|---|---|---|
| Engine | MongoDB or PostgreSQL (set by `DATABASE_URL`) | PostgreSQL only |
| Queries | mongoose-style: `find(filter, { sort, limit, populate })`, `$set`, `$inc` | Prisma-style: `findMany({ where, include, orderBy, take, cursor })`, `findUnique`, `upsert`, `groupBy`, `aggregate` |
| Relations | `ref` + `populate` (a plain column on PostgreSQL) | real foreign keys, many-to-many join tables, `include` in one SQL statement, relation filters, nested writes |
| Field types | the portable set (`string`, `number`, `boolean`, `date`, `objectId`, objects, arrays) | + `integer`, `bigint`, `decimal`, `uuid`, `json`, `varchar`, native arrays and enums, `serial` ids |
| Migrations | auto-sync, `efc db generate` | auto-sync, `efc db generate`, `efc db pull`, `efc import-prisma` |
| Wrong engine | — | fails at first use with an `[EFC]` error naming the model |

## Pick one

- **Building on PostgreSQL:** use `defineTable`. You get foreign keys, joins and SQL types. `create-efc-app` generates `defineTable` models for PostgreSQL apps.
- **Building on MongoDB:** use `defineModel`. On MongoDB it *is* mongoose underneath (`Model.raw()` hands you the mongoose model), with `aggregate()`, TTL indexes and transactions on a replica set.
- **The app may switch engines, or ships to both:** use `defineModel` and stay inside the shared filter and update subset (`$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or`; `$set $unset $inc $push $pull`).
- **Coming from Prisma:** use `defineTable`. `efc import-prisma` writes the models for you. See [Coming from Prisma](./coming-from-prisma.md).

## The same query, both ways

```ts
// defineModel
const posts = await Post.find(
  { status: 'published', views: { $gte: 100 } },
  { sort: { createdAt: -1 }, limit: 20, populate: 'author' },
);
await Post.update(id, { $inc: { views: 1 } });

// defineTable
const posts = await Post.findMany({
  where: { status: 'published', views: { gte: 100 } },
  orderBy: { createdAt: 'desc' },
  take: 20,
  include: { author: true },
});
await Post.update({ where: { id }, data: { views: { increment: 1 } } });
```

## Moving between them

On PostgreSQL, a `defineModel` and a `defineTable` over the same table read and write the same records, so you can move one model at a time. Two things change on the way:

- A `ref` becomes a real foreign key. The field's `type` must match the target's id (`uuid` for the default id, `integer` for `id: 'serial'`). Rows pointing at missing records don't block the deploy: the key is added `NOT VALID`, and validation is skipped with a warning naming the count.
- An array of refs (a `jsonb` column under `defineModel`) moves into a join table on the first sync. The old column is kept but no longer read, so don't keep a `defineModel` writing that field afterwards.

Run `efc db sync --dry-run` before you switch to see exactly what will change.

See also: [Database guide](./database.md) · [Relations](./relations.md) · [`defineModel` API](../api-reference/db.md) · [`defineTable` API](../api-reference/table.md)
