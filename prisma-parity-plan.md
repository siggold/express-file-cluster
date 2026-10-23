# Plan: a data layer that competes with Prisma — the EFC way

> Status: proposal (2026-10-13). Baseline: v0.4.0 + the `feat/postgres-like-mongo` branch
> (auto schema sync, mongoose-style undeclared fields, `efc db sync`, studio structure view).

## Goal

A team choosing between **Prisma** and EFC for a new PostgreSQL app should be able to pick EFC
without giving up anything they use day to day — and a MongoDB team should get a data layer that
is *more* native than mongoose, not a SQL ORM squeezed onto documents. On top of that, EFC keeps what
Prisma can't offer: no schema language and no codegen step, validation built in, and a schema that
keeps itself in step with the code.

**Win condition (PostgreSQL):** an app built from the Prisma docs' core guides (CRUD, relations,
filtering, pagination, aggregation, transactions, migrations, type safety) can be written with
`defineTable` in the same number of lines or fewer, with equal type safety, within 15% of Prisma's
latency on the benchmark suite.

**Win condition (MongoDB):** everything an app uses mongoose for — embedded documents, `$lookup`,
aggregation pipelines, geo and text search, bulk writes, change streams — available through
`defineCollection` with inferred types and EFC's validation and sync.

## Architecture: one foundation, three model APIs

Engines are not forced through one API. Each gets the vocabulary and capabilities that are natural
to it; nothing is emulated across engines.

```
                ┌────────────────────────────────────────────────────────┐
  defineModel   │ portable core — identical on both engines (today's API)│
                ├───────────────────────────┬────────────────────────────┤
  defineTable   │ PostgreSQL-native          │                            │  defineCollection
                │ Prisma-style queries,      │ MongoDB-native             │
                │ FKs, joins, SQL types,     │ pipelines, $lookup, geo,   │
                │ groupBy, upsert, cursors   │ text, bulkWrite, streams   │
                └───────────────────────────┴────────────────────────────┘
  shared foundation: schema format · type inference · validation · auto-sync ·
                     transaction() · undeclared-field rules · errors · logging
```

| | `defineModel` | `defineTable` | `defineCollection` |
|---|---|---|---|
| Engine | either (set by `DATABASE_URL`) | PostgreSQL only | MongoDB only |
| Vocabulary | `find/findOne/create/update…` (today) | Prisma-style: `findMany({ where, include, orderBy, take, cursor })`, `findUnique`, `upsert`, `groupBy`, `aggregate({ _count, _sum })` | mongoose-style: `find(filter, { projection, sort })`, `aggregate(pipeline)`, `lookup`, `bulkWrite`, `watch` |
| Relations | `ref` + `populate` (batched) | real foreign keys, `include` as one SQL statement, relation filters, nested writes | `ref` + `$lookup`, embedded documents first-class |
| Field types | portable set | + `integer`, `bigint`, `decimal`, `varchar`, `uuid`, `json`, arrays | + `decimal128`, `long`, `geoPoint`, `binary` |
| Use it when | the app may switch engines, or uses both | building on PostgreSQL | building on MongoDB |

- **Type-level separation.** `defineTable(...)` returns a `TableModel` whose type only has
  PostgreSQL methods; `defineCollection(...)` returns a `CollectionModel` with MongoDB methods. Calling
  a PostgreSQL method on a collection is a **compile error**, not a runtime surprise. Using
  `defineTable` against a MongoDB connection fails at first use with an `[EFC]` error naming the model.
- **Same records, same table.** A `defineModel` and a `defineTable` over the same table read and
  write identical records, so an existing app can move one model at a time.
- **`defineModel` stays as it is.** No breaking change; it remains the portable choice and gains
  only what is genuinely shared (M1 types, M2's portable items).

## Standards this plan must keep

1. **Shared core identical, native APIs never emulated.** Everything in the foundation and in
   `defineModel` behaves the same on both engines and runs in the engine **conformance suite**.
   Engine-native features live only on `defineTable` / `defineCollection`, with their own suites
   (`db/table.integration.test.ts`, `db/collection.integration.test.ts`). No MongoDB foreign-key
   emulation, no PostgreSQL pipeline emulation.
2. **No codegen, no build step.** Types are inferred from the schema object.
3. **Three import paths only.** `defineTable`, `defineCollection` and new types export from
   `express-file-cluster`.
4. **Safe by default.** Automatic sync never drops a column, a row or data; destructive changes need
   an explicit migration or flag. Validation stays in the model.
5. **Fail loud and clear.** `ModelValidationError` (400 + `issues`), 409 on conflicts, `[EFC]` errors
   that say what to do.
6. **Optional peers.** No new mandatory dependency.
7. **Conventions over configuration.** Sensible defaults, everything overridable per model.
8. **Proven end to end.** Every milestone extends the e2e suite and passes the release rehearsal
   (`scripts/release-rehearsal/run.sh`); docs, Skills cards and CLAUDE.md updated in the same PR.
9. **Additive.** Existing apps keep working; new APIs and types are opt-in.

---

## Gap analysis (today vs Prisma / mongoose)

| Area | Reference | EFC today | Where it lands |
|---|---|---|---|
| Type safety | Prisma: generated types | hand-written generic, can drift | M1 (all three APIs) |
| Numeric / string / key types | Prisma: Int, BigInt, Decimal, VarChar, autoincrement | `number` (double), `text`, uuid only | M2 (`defineTable`) |
| Prisma-style queries: `where`/`include`/`orderBy`/`take`/`cursor`/`distinct`, `findUnique` | Prisma | — | M2 |
| Upsert | Prisma, mongoose | — | M2 (`defineTable`), M5 (`defineCollection`), portable form in M1.3 |
| Aggregates / groupBy | Prisma | MongoDB pipeline only | M2 (`defineTable`), M5 typed pipelines |
| Relations: FKs, joins, back-relations, m:n join tables, relation filters, nested writes, referential actions | Prisma | `ref` + batched `populate`, top-level only | M3 (`defineTable`) |
| `$lookup`, embedded docs, geo, text, bulkWrite, change streams | mongoose / driver | `aggregate()` passthrough only | M5 (`defineCollection`) |
| Migrations from model diffs, drift check | Prisma Migrate | hand-written; auto-sync adds/converts | M4 |
| Introspect an existing DB | `prisma db pull` | — | M4 |
| Push schema without migrations | `prisma db push` | `autoSync` / `efc db sync` ✅ | — |
| Studio | Prisma Studio (edit) | read-only rows + structure ✅ | M6 |
| Query logging / metrics | Prisma `log`, metrics | `logging.queries` (ops, statements, slow, N+1) — metrics not yet | M6 |
| Validation | none in Prisma | built in ✅ | — |
| Interactive transactions | `$transaction(async tx => …)` | `transaction(fn)` ✅ (implicit) | — |

---

## M1 — Shared foundation: types you don't write

Applies to all three APIs.

### 1.1 Type inference from the schema
```ts
export const User = defineTable('User', {
  name:    { type: 'string', required: true },
  role:    { type: 'string', enum: ['member', 'admin'], default: 'member' },
  address: { city: { type: 'string', required: true }, zip: { type: 'string' } },
});

type UserRecord = InferRecord<typeof User>;
// { id: string; name: string; role: 'member' | 'admin';
//   address?: { city: string; zip?: string }; createdAt: Date; updatedAt: Date }
```
- `const` type parameter maps the schema to record, create-input, filter and update types:
  `required`/`default` → non-optional, `enum` → literal union, nested objects/arrays recurse.
- The explicit generic (`defineModel<User>(...)`) keeps working.
- **Tests:** type-level suite (`expectTypeOf`) plus a must-not-compile file, checked by `tsc` in CI.

### 1.2 Engine guard
`defineTable` / `defineCollection` record their engine; first use on the wrong engine throws
`[EFC] User is a PostgreSQL table (defineTable) but DATABASE_URL points at MongoDB`.

### 1.3 Portable additions to `defineModel`
Only what both engines do natively and identically: `upsert(filter, create, update)`,
`updateOne/deleteOne(filter)`, `exists(filter)`, `distinct(field, filter)`. Everything else stays
engine-native.

**Exit criteria:** no hand-written interfaces needed in the scaffolded apps; v0.4 apps compile unchanged.

**Status: done (branch `feat/m1-inferred-types`).** Notes from building it:
- One `defineModel` signature, no overloads: an explicit `T` keeps v0.4 typing exactly; otherwise a
  `const` schema parameter is inferred. A schema widened to `ModelSchema` falls back to v0.4's loose type.
- The engine guard is internal plumbing (`createModel(..., { engine, api, kind })`) until
  `defineTable` / `defineCollection` exist; tested on both engines.
- `upsert` = one-statement `updateOne`, else `create`; a 409 on create is retried once as an update
  (outside transactions — a failed insert aborts a PostgreSQL transaction).
- Found while typing: PostgreSQL returned dates nested in jsonb as ISO strings (MongoDB: `Date`);
  records now revive them from the schema on both engines.

---

## M2 — `defineTable`: PostgreSQL-native model & queries

### 2.1 Types, keys, naming
| Field type | Column |
|---|---|
| `integer`, `bigint` | `integer`, `bigint` (`bigint` values as JS `bigint`) |
| `decimal` (`precision`, `scale`) | `numeric(p,s)` — values as `string`, exact |
| `string` + `maxLength` | `varchar(n)` (new columns; sync never shrinks) |
| `uuid`, `json`, `array` (`of`) | `uuid`, `jsonb`, native arrays (`text[]`, `integer[]`, …) |
| `enum` | `CHECK` today; `nativeEnum: true` → `CREATE TYPE … AS ENUM` |

`ModelOptions.id`: `'uuid'` (default) | `'serial'` | `'bigserial'`, `idType: 'number'` opt-in;
`naming: 'snake_case'` and per-field `column`.

### 2.2 Prisma-style query API
```ts
await User.findMany({
  where: { role: 'admin', email: { endsWith: '@acme.io', mode: 'insensitive' }, OR: [...] },
  orderBy: [{ createdAt: 'desc' }],
  take: 20, cursor: { id: last }, skip: 1,
  select: { name: true, email: true },
  distinct: ['email'],
});
await User.findUnique({ where: { email } });
await User.upsert({ where: { email }, create: {...}, update: {...} });        // INSERT … ON CONFLICT
await User.updateMany({ where, data: { logins: { increment: 1 } } });
await Order.groupBy({ by: ['status'], _count: true, _sum: { total: true }, having: {...} });
await Order.aggregate({ _avg: { total: true }, where });
```
Filter operators follow Prisma's names (`equals`, `in`, `notIn`, `lt`, `contains`, `startsWith`,
`mode: 'insensitive'`, `AND/OR/NOT`), compiled to parameterised SQL via Drizzle.

**Exit criteria:** Prisma's "CRUD", "filtering and sorting", "pagination" and "aggregation" guides
pass as `defineTable` tests.

**Status: done (branch `feat/m2-define-table`).** Notes from building it:
- One table layer (`pg-table.ts`: columns, Drizzle table, sync, records, validation, errors) under
  both query layers — defineModel's MongoDB-style `pg-model.ts` and defineTable's `table-model.ts`.
- Queries compile to one parameterised statement each via Drizzle's `sql`; values go through the
  Drizzle columns' encoders/decoders so raw SQL and the query builder agree on types.
- `idType: 'number'` from the draft was dropped: `serial` ids are numbers, `bigserial` ids are
  bigints, `uuid` ids strings. Pages are totally ordered (ties broken by `id`), and cursors are
  NULL-aware for any orderBy.
- `ignite()` sends bigints as JSON strings. Not yet: `include`/relations (M3), `create-efc-app`
  choosing `defineTable` for PostgreSQL apps (with M3, when the generated routes can use relations).

---

## M3 — `defineTable`: relations

```ts
export const Post = defineTable('Post', {
  title:  { type: 'string', required: true },
  author: { type: 'objectId', ref: 'User', required: true, onDelete: 'cascade' },
  tags:   { type: 'array', of: 'objectId', ref: 'Tag' },               // m:n via join table
}, {
  relations: { comments: { hasMany: 'Comment', foreignKey: 'post' } },
});

await Post.findMany({
  where: { author: { is: { role: 'admin' } }, comments: { some: { approved: false } } },
  include: { author: { select: { name: true } }, comments: { where: { approved: true }, take: 3, include: { author: true } } },
});
await Post.create({ data: { title, author: { connect: { id } }, tags: { connectOrCreate: [...] } } });
```
- Real `REFERENCES … ON DELETE` (`restrict` default | `cascade` | `setNull`), added by sync
  `NOT VALID` and validated separately so dirty data can't block a deploy. **Done (M3a)** —
  scalar refs; target tables synced first; 400/409 error mapping.
- m:n → auto-managed join tables with FKs; records keep `tags: string[]`. **Done (M3a-2)** — join
  table `<table>_<column>` (owner_id, ref_id, position); first sync backfills from the old
  array/jsonb column (kept). `relations`, `include`, filters and nested writes remain (M3b/c).
- `include` → one statement (`LEFT JOIN LATERAL … json_agg`), any depth; included fields typed.
  **Done (M3b)** — correlated jsonb subqueries, `relations: { hasMany | hasOne, foreignKey }`,
  typed through a `Tables` declaration-merging registry.
- Relation filters `is/isNot/some/every/none` → `EXISTS` sub-queries; nested writes in one transaction.
  **Done (M3c)** — M3 complete.

**Exit criteria:** Prisma's relations guide (1:1, 1:n, m:n, self-relations, referential actions) as
tests; populate/include issues one statement per call (asserted via M6 query logging).

---

## M4 — Schema lifecycle (both engines)

1. **`efc db generate <name>`** — writes the sync plan as a migration (`up` SQL + best-effort `down`).
   Destructive changes only here, explicitly: `removed: true` / `--allow-drop`, `renamedFrom: 'old'`
   (→ `RENAME COLUMN`), tightening (`NOT NULL`, validated `CHECK`) with a pre-check listing offending rows.
2. **Drift check:** `efc db sync --dry-run --exit-code` for CI.
3. **Verify:** `efc db generate --verify` replays migrations on a throwaway schema and compares.
4. **`efc db pull`** — PostgreSQL: introspect tables, types, FKs, indexes, enums → `defineTable`
   files with relations. MongoDB: sample collections + indexes → `defineCollection` files.
5. **Coming from Prisma:** guide + `npx efc import-prisma schema.prisma` → `defineTable` files.

**Exit criteria:** pull → generate → migrate round-trips the Prisma sample schemas with no diff.

**Done (0.9.0)** — `efc db generate [--allow-drop] [--tighten] [--verify]` (diff against migrations
replayed into a shadow schema/database, `Model.sync()` suppressed there), `renamedFrom`,
`sync --dry-run --exit-code`, `migrate --baseline`, `efc db pull` (PostgreSQL) and
`efc import-prisma`. MongoDB `pull` lands with M5 (it emits `defineCollection`). Exit criterion
covered by `__tests__/integration/db-generate.test.ts`.

---

## M5 — `defineCollection`: MongoDB-native model

```ts
export const Place = defineCollection('Place', {
  name:     { type: 'string', required: true },
  location: { type: 'geoPoint', index: '2dsphere' },
  price:    { type: 'decimal128' },
  reviews:  [{ rating: { type: 'integer', min: 1, max: 5 }, text: { type: 'string' } }],
});

await Place.find({ location: { $near: { $geometry: point, $maxDistance: 2000 } } }, { projection: { name: 1 }, sort: { name: 1 } });
await Place.aggregate([ { $match: {...} }, { $unwind: '$reviews' }, { $group: {...} } ]);   // typed stages
await Place.lookup('owner', { from: 'User' });                                           // $lookup helper
await Place.bulkWrite([ { updateOne: {...} }, { deleteMany: {...} } ]);
for await (const change of Place.watch([{ $match: { operationType: 'insert' } }])) { … }
await Place.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
```
- Typed pipeline builder (stage-by-stage result types inferred from M1 record types).
- Text (`$text`) and geo queries, TTL and partial indexes, collations, transactions with sessions.
- Validation and auto-sync from the shared foundation; mongoose remains the driver underneath.

**Exit criteria:** the mongoose guide's queries/aggregation/population/geo examples as
`defineCollection` tests.

---

## M6 — Tooling, observability, performance (both engines)

- **Query logging:** `logging.queries: true | { slowMs }` — model, operation, duration, `reqId`;
  slow-query warnings; N+1 detector naming the call site. **Done (M6a)** — also counts statements
  per operation (`onQuery` in `db/query-log.ts`), which M3's one-statement tests assert on.
- **Studio, editable:** opt-in `efc db studio --write` (localhost-only + CSRF token), writes go
  through the models so validation applies.
- **Pool settings:** `database: { pool: { max, idleTimeoutMs } }`; prepared statements on PostgreSQL.
- **Benchmarks:** `bench/` vs Prisma and Drizzle (PostgreSQL) and mongoose (MongoDB), nightly in CI;
  > 10% regressions fail.

## M7 — Docs & positioning

"Which API do I use?" page (the table above), "Coming from Prisma", "Coming from mongoose", relation
and aggregation guides, type-inference reference, and a feature matrix generated from test names.

---

## Sequencing & size

| Milestone | Depends on | Size | Ships as |
|---|---|---|---|
| M1 shared types, engine guard, portable additions | — | M | 0.5.0 |
| M2 `defineTable` types + Prisma-style queries | M1 | M | 0.6.0 |
| M3 `defineTable` relations | M2 | L | 0.7.0 (FKs + include / filters + nested writes) |
| M4 schema lifecycle | M2, M3 | L | 0.8.0 |
| M5 `defineCollection` | M1 (can run in parallel with M2–M3) | M | 0.6.x–0.7.x |
| M6 tooling & benchmarks | M1; benchmarks gate M3+ | M | alongside |
| M7 docs | each milestone | S | alongside |

Each milestone is a PR series; every PR green on CI (both engines + e2e) and the release rehearsal.

## Risks

| Risk | Mitigation |
|---|---|
| Three model APIs = more surface to maintain | one foundation (schema tree, validation, sync, errors, logging) under all three; native layers only add query builders |
| Users unsure which API to pick | `create-efc-app` picks `defineTable` / `defineCollection` from the chosen database and offers "portable (`defineModel`)" as an option; "Which API" doc |
| Type inference slow on big schemas | depth cap; `tsc --extendedDiagnostics` budget in CI; explicit generic still available |
| Moving a `defineModel` m:n array (jsonb) to a join table | opt-in `efc db sync --migrate-relations`; both layouts readable during transition |
| Auto-sync adding FKs fails on dirty data | `NOT VALID` + separate validation with an offending-rows report |
| Scope creep | the two win conditions are the scope; everything else goes to the backlog |

## Out of scope (backlog)

Composite primary keys · views & materialized views · row-level security helpers · multi-schema /
multi-tenant · read replicas · other databases.
