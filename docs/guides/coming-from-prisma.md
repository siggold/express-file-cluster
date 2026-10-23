# Coming from Prisma

`defineTable` speaks Prisma's query language on PostgreSQL, with the schema written in TypeScript instead of a `.prisma` file and no generate step. This guide moves a Prisma app over.

---

## 1. Import the schema

```bash
npx efc import-prisma prisma/schema.prisma
# → src/model/User.ts, Post.ts, … and src/model/index.ts
```

`import-prisma` writes one `defineTable` model per Prisma model, over the **same tables and columns**:

| Prisma | EFC |
|---|---|
| `model Post { … }` (table `Post`) / `@@map("posts")` | `defineTable('Post', …, { collection: 'Post' })`, or nothing when the name already matches EFC's default (`posts`) |
| `id String @id @default(uuid())` | the default `uuid` id |
| `id Int @id @default(autoincrement())` / `BigInt` | `{ id: 'serial' }` / `{ id: 'bigserial' }` |
| `String`, `Int`, `BigInt`, `Float`, `Decimal`, `Boolean`, `DateTime`, `Json` | `string`, `integer`, `bigint`, `number`, `decimal`, `boolean`, `date`, `json` |
| `@db.VarChar(80)`, `@db.Decimal(10, 2)`, `@db.Uuid` | `maxLength: 80`, `precision: 10, scale: 2`, `uuid` |
| `String[]` | `{ type: 'array', of: 'string' }` (a native `text[]`) |
| `enum Role { USER ADMIN }` | `{ type: 'string', enum: ['USER', 'ADMIN'], nativeEnum: true }` |
| required (no `?`) | `required: true` |
| `@unique`, `@@unique([a, b])`, `@@index([a, b(sort: Desc)])` | `unique: true`, `indexes: [{ fields: { a: 1, b: -1 }, unique? }]` |
| `@default(now())`, `uuid()`/`cuid()`, literals, `autoincrement()` | `'$now'`, `'$uuid'`, the literal, `sequence: true` |
| `@map("col")` | `column: 'col'` |
| `createdAt @default(now())` + `updatedAt @updatedAt` | EFC timestamps (the default) |
| `author User @relation(fields: [authorId], references: [id], onDelete: Cascade)` + `authorId Int` | `author: { type: 'integer', ref: 'User', required: true, column: 'authorId', onDelete: 'cascade' }`: one field, a real foreign key |
| `posts Post[]` (the other side) | `relations: { posts: { hasMany: 'Post', foreignKey: 'author' } }` |
| `profile Profile?` (the other side of a unique FK) | `relations: { profile: { hasOne: 'Profile', foreignKey: 'user' } }` |
| implicit many-to-many `categories Category[]` ↔ `posts Post[]` | an array of refs on one side (`{ type: 'array', of: 'integer', ref: 'Post' }`), a `hasMany` relation on the other |

Whatever doesn't carry over is listed as a comment at the top of the model. That includes composite ids and foreign keys, `Bytes` and `Unsupported(...)` types, `dbgenerated()` defaults, and `onDelete: SetDefault`. MongoDB Prisma schemas are refused: `defineTable` is PostgreSQL-only.

**One naming difference.** Prisma keeps a relation (`author`) and its foreign-key scalar (`authorId`) as two fields. EFC has one field, `author`, holding the id. It's stored in the `authorId` column, and `include: { author: true }` swaps the id for the record. Write `{ author: userId }` where Prisma wrote `{ authorId: userId }`.

## 2. Point EFC at the database

Two routes:

- **A new database:**
  ```bash
  efc db generate init --tighten   # a migration for the whole schema, with NOT NULLs
  efc db migrate
  ```
- **The database Prisma already manages:** try it on a copy first.
  ```bash
  efc db sync --dry-run             # what EFC would change on the live tables
  ```
  Expect EFC's own names for constraints and indexes it adds, `timestamptz` for `DateTime` columns, and a `<table>_<column>_enum` type per enum column. Prisma's `_AToB` join tables aren't read: copy their rows into EFC's join table (`<table>_<field>`: `owner_id`, `ref_id`, `position`) once it exists. The model comment says which table to copy from.

From then on, `efc db generate <name>` writes migrations from model changes. See [Migrations](./migrations.md).

## 3. Port the queries

Most Prisma Client calls keep their shape. Swap `prisma.post` for the `Post` model:

| Prisma Client | EFC |
|---|---|
| `prisma.post.findMany({ where, orderBy, take, skip, cursor, select, include, distinct })` | `Post.findMany({ … })`, same keys |
| `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `count`, `aggregate`, `groupBy` | same names |
| `create`, `createMany({ skipDuplicates })`, `createManyAndReturn` | same |
| `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, `deleteMany` | same |
| filters: `equals`, `in`, `lt`…, `contains`/`startsWith` + `mode: 'insensitive'`, `AND`/`OR`/`NOT`, `some`/`every`/`none`, `is`/`isNot`, `has` | same |
| updates: `{ increment: 1 }`, `set`, `push` | same |
| nested writes: `connect`, `create`, `connectOrCreate`, `disconnect`, `set`, `delete`, `deleteMany` | same (in `create`, `update`, `upsert`) |
| `prisma.$transaction(async (tx) => { tx.post… })` | `transaction(async () => { Post… })`: no `tx` to pass, calls inside join it |
| `prisma.$queryRaw` | `db.query(sql, params)` (the `pg` Pool) |
| generated types (`Prisma.PostGetPayload<…>`) | inferred from the schema: `InferRecord<typeof Post>`, `InferCreate<typeof Post>` |

What you gain: validation in the model (`ModelValidationError` → 400 with `issues`), 409 on unique conflicts, and no `prisma generate` step. You also get a schema that keeps itself in step on first use (`autoSync`), or migrations written for you.

See [`defineTable`](../api-reference/table.md) for the full reference.
