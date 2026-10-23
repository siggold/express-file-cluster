import type { RequestHandler, ErrorRequestHandler } from 'express';

export type DatabaseEngine = 'mongodb' | 'postgresql';
export type AuthStrategy = 'http-only' | 'localStorage';
export type TaskBackend = 'bullmq' | 'pg-boss';

export interface TaskConfig {
  backend: TaskBackend;
  /** BullMQ only. Default: redis://localhost:6379. */
  redisUrl?: string;
  /** pg-boss only. Default: `databaseUrl`. */
  connectionString?: string;
  /** pg-boss only: Postgres schema for its tables. Default: 'pgboss'. */
  schema?: string;
  concurrency?: number;
  /** Max milliseconds `enqueue()` waits for Redis before rejecting. Default: 5000. */
  enqueueTimeout?: number;
  /**
   * Queue name. Apps sharing one Redis database (or Postgres schema, for pg-boss) must
   * use different names, or they will run each other's jobs. Default: 'efc'.
   */
  queue?: string;
}

interface CacheCommon {
  /** Key prefix, so apps can share one store. Default: 'efc:'. */
  prefix?: string;
  /**
   * What `requireAuth` does when it can't reach the cache to check for revoked sessions:
   * - `'reject'` (default): answer 503 — a revoked token can never slip through, at the
   *   cost of authenticated routes being unavailable during the outage.
   * - `'allow'`: let the request through and log an error — availability first.
   */
  onRevocationCheckError?: 'reject' | 'allow';
}

export type CacheConfig =
  | (CacheCommon & {
      backend: 'redis';
      /** Default: redis://localhost:6379. Supports rediss://, ACL users and /db. */
      url?: string;
      /** Per-command timeout in ms before treating Redis as unavailable. Default: 1000. */
      timeout?: number;
    })
  | (CacheCommon & {
      /**
       * In-process store. Under clustering it lives in the primary and workers reach it
       * over IPC, so all workers share it — but it is still one machine's memory: not
       * shared across instances, and emptied on restart. Use Redis for multi-instance.
       */
      backend: 'memory';
      /** Least-recently-used entries are evicted beyond this. Default: 10 000. */
      maxEntries?: number;
    });

export interface LoggingConfig {
  /** Minimum level to emit. Default: 'info'. */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** Human-readable lines instead of JSON. Default: on in a non-production TTY. */
  pretty?: boolean;
  /** Log one line per completed request (method, url, status, duration). Default: true. */
  requests?: boolean;
  /**
   * Model operation logging: model, operation, duration, statement count, request ID.
   * `true` logs every operation; an object logs only slow ones unless `all: true`.
   * Operations slower than `slowMs` warn either way. Default: off.
   */
  queries?: boolean | QueryLogConfig;
}

export interface QueryLogConfig {
  /** Log every operation (info), not just slow ones. Default: false (true with `queries: true`). */
  all?: boolean;
  /** Operations taking at least this long are logged as warnings. Default: 500. */
  slowMs?: number;
  /**
   * Warn (once, naming the calling line) when one request runs the same model operation
   * this many times — the N+1 pattern. `false` turns it off. Default: 10.
   */
  nPlusOne?: number | false;
}

export interface CorsConfig {
  origin?: string | string[] | boolean;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
}

export interface EFCConfig {
  port?: number;
  basePath?: string;
  dashboard?: boolean;
  database?: DatabaseEngine;
  databaseUrl?: string;
  authStrategy?: AuthStrategy;
  jwtSecret?: string;
  /** JWT lifetime, e.g. '15m', '1h', '7d'. Default: '7d'. */
  jwtExpiresIn?: string;
  /** Cookie domain for the 'http-only' auth strategy. Default: unset (host-only cookie). */
  cookieDomain?: string;
  cluster?: boolean;
  workers?: number;
  tasks?: TaskConfig | false;
  cors?: boolean | CorsConfig;
  /**
   * Key/value cache (`cache`, `cacheResponse`) — and the store `requireAuth` checks
   * for revoked sessions (`revokeSession`, `revokeAllSessions`).
   */
  cache?: CacheConfig | false;
  /**
   * Keep tables/collections and indexes in step with your models automatically, the
   * first time each model is used in a process — like mongoose does for collections and
   * indexes. Turn off to manage the schema only through migrations (`Model.sync()`,
   * `efc db sync`). Default: true.
   */
  autoSync?: boolean;
  /** Structured logging (pino). `false` silences framework logs. */
  logging?: LoggingConfig | false;
  /** Request timeout in milliseconds. Requests exceeding this duration will be terminated with 408. */
  requestTimeout?: number;
  globalMiddlewares?: RequestHandler[];
  onWorkerReady?: (id: number) => void;
  onWorkerCrash?: (id: number, code: number) => void;
  onError?: ErrorRequestHandler;
}

export interface RouteEntry {
  urlPath: string;
  filePath: string;
  params: string[];
  /** Set for routes with a catch-all segment; captures map onto `params` in order. */
  pattern?: RegExp;
}

export interface RouteMethodMeta {
  description?: string;
  request?: {
    headers?: Record<string, string>;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status?: number;
    body?: unknown;
  };
}

/**
 * Keyed by HTTP method (`GET`, `POST`, ...) so each method implemented in a
 * route file gets its own documentation block in the dashboard.
 */
export type RouteMeta = Partial<Record<string, RouteMethodMeta>>;

/**
 * Any Standard Schema validator (zod >=3.24, valibot, arktype, ...) or an object
 * with a zod-style `safeParse`. EFC never imports a validation library itself.
 */
export type Validator =
  | { readonly '~standard': { validate: (value: unknown) => unknown } }
  | { safeParse: (value: unknown) => unknown };

/** Validators for each part of the request; every key is optional. */
export interface RequestSchema {
  params?: Validator;
  query?: Validator;
  body?: Validator;
}

/**
 * `export const schema` in a route file: either one `RequestSchema` applied to every
 * method, or keyed by method (`{ POST: { body }, GET: { query } }`).
 */
export type RouteSchema = RequestSchema | Partial<Record<string, RequestSchema>>;

export interface ValidationIssue {
  location: 'params' | 'query' | 'body';
  /** Dot-joined path inside that location, e.g. `address.zip`; empty for the root. */
  path: string;
  message: string;
}

export interface MountedRoute extends RouteEntry {
  methods: string[];
  meta?: RouteMeta;
}

export interface TaskOptions {
  thread?: boolean;
  retries?: number;
  backoff?: 'fixed' | 'exponential';
  concurrency?: number;
  /**
   * Cron pattern for recurring runs, e.g. `'0 3 * * *'` (daily 03:00). A 6-field
   * pattern adds seconds. The handler receives `{}` as its payload on scheduled runs.
   */
  schedule?: string;
  /** IANA timezone for `schedule`, e.g. `'Europe/Berlin'`. Default: server local time. */
  timezone?: string;
}

export interface TaskDefinition<TPayload = unknown> {
  handler: (payload: TPayload) => Promise<void>;
  options: TaskOptions;
  name: string;
  filePath?: string;
}

/** Primitive field types usable directly, or as the item type of an `array` field via `of`. */
export type PrimitiveFieldType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'objectId';

/**
 * Sentinel default-value codes, resolved at schema-compile time to a generator
 * function so each document gets a freshly-computed value (never baked in once
 * at schema-definition time):
 * - `'$now'` — the current `Date` (pair with `type: 'date'`)
 * - `'$uuid'` — a fresh `crypto.randomUUID()` string (pair with `type: 'string'`)
 * - `'$objectId'` — a fresh Mongoose `ObjectId` (pair with `type: 'objectId'`)
 * - `'$timestamp'` — the current epoch milliseconds as a `number` (pair with `type: 'number'`)
 * - `'$shortId'` — a random 16-character base64url string (pair with `type: 'string'`);
 *   a shorter, non-UUID-shaped alternative to `'$uuid'` for tokens/keys
 * - `'$currentUser'` — the JWT payload `requireAuth` attached to the in-flight request
 *   (via `getCurrentUser()`), or `undefined` outside a request / without `requireAuth`
 * - `` `$currentUser.<key>` `` — a single field plucked from that payload, e.g.
 *   `'$currentUser.id'` (pair with a `type` matching that field's shape)
 *
 * `'$increment'` is intentionally NOT a `default` code — see `FieldDefinition.sequence`
 * instead. Auto-increment needs an async read-modify-write against a counters
 * collection; mongoose resolves `default` synchronously, so it can't live here.
 *
 * Any other string/value passed to `default` is used as a literal default, unchanged.
 */
export type DefaultOperator =
  | '$now'
  | '$uuid'
  | '$objectId'
  | '$timestamp'
  | '$shortId'
  | '$currentUser'
  | `$currentUser.${string}`;

export interface FieldDefinition {
  type: PrimitiveFieldType | 'array';
  required?: boolean;
  unique?: boolean;
  /** Creates a single-field index. Use `ModelOptions.indexes` for compound/TTL/text. */
  index?: boolean;
  /** A literal default value, or a `DefaultOperator` sentinel code (see above). */
  default?: unknown;
  /** Restricts the field to a fixed set of values. Valid on `string` and `number` types. */
  enum?: readonly (string | number)[];
  /** Inclusive bounds for `number` (and `date`) fields. */
  min?: number | Date;
  max?: number | Date;
  /** Inclusive length bounds for `string` fields. */
  minLength?: number;
  maxLength?: number;
  /** `string` fields must match this pattern. */
  match?: RegExp;
  /**
   * Custom check: return `true` to accept, `false` or an error message to reject.
   * May be async. Runs on create and on update of this field.
   */
  validate?: (value: unknown) => boolean | string | Promise<boolean | string>;
  /**
   * Model name to reference. Valid on `objectId` types (bare or as an array's `of`); on
   * `defineTable`, a top-level field whose type matches the target's id (`uuid`/`objectId`,
   * `integer` for `id: 'serial'`, `bigint` for `'bigserial'`) and becomes a foreign key.
   */
  ref?: string;
  /**
   * Item type for `array` fields: a primitive (`of: 'string'`) or a nested schema for an
   * array of embedded documents (`of: { sku: {...}, qty: {...} }`). Omit for an untyped array.
   */
  of?: PrimitiveFieldType | ModelSchema;
  /**
   * Typed fields for an embedded `object`, e.g.
   * `{ type: 'object', required: true, fields: { city: {...}, zip: {...} } }`.
   * Without `fields`, an `object` stores any JSON value unvalidated.
   */
  fields?: ModelSchema;
  /**
   * Auto-increments a shared counter and assigns it on insert, before `required`
   * validation runs. `true` uses `'<ModelName>.<field>'` as the counter key; a string
   * sets an explicit key so multiple fields/models can share one counter (e.g. a
   * global order number). MongoDB stores counters in `efc_counters`; PostgreSQL uses a
   * real `SEQUENCE`. Only supported on top-level fields.
   */
  sequence?: boolean | string;
  /**
   * The field's previous name (top-level fields only). PostgreSQL: sync renames the old
   * column instead of adding an empty one. MongoDB: `efc db generate` writes a migration
   * that `$rename`s the field in stored documents.
   */
  renamedFrom?: string;
}

/**
 * A schema field is one of:
 * - a `FieldDefinition` (`{ type: 'string', required: true }`)
 * - a nested `ModelSchema` — shorthand for an embedded object with typed fields:
 *   `address: { city: { type: 'string' }, zip: { type: 'string' } }`
 * - a one-element tuple holding a nested `ModelSchema` — an array of embedded
 *   documents: `items: [{ sku: { type: 'string' } }]`
 */
export type SchemaField = FieldDefinition | ModelSchema | [ModelSchema] | readonly [ModelSchema];

// ── defineTable (PostgreSQL-native) schema ───────────────────────────────────

/** Field types `defineTable` accepts: the portable ones plus SQL-native types. */
export type TablePrimitiveFieldType =
  | PrimitiveFieldType
  /** `integer` (int4) — a JS `number`, whole and 32-bit. */
  | 'integer'
  /** `bigint` (int8) — a JS `bigint`. */
  | 'bigint'
  /** `numeric(precision, scale)` — exact; values are decimal `string`s. */
  | 'decimal'
  /** `uuid` — a `string`. */
  | 'uuid'
  /** `jsonb` — any JSON value, unvalidated. */
  | 'json';

export interface TableFieldDefinition extends Omit<
  FieldDefinition,
  'type' | 'of' | 'fields' | 'min' | 'max'
> {
  type: TablePrimitiveFieldType | 'array';
  /** Inclusive bounds; `bigint`/`decimal` fields also take `bigint` / decimal strings. */
  min?: number | bigint | string | Date;
  max?: number | bigint | string | Date;
  /** `decimal` only: total significant digits (`numeric(precision, scale)`). */
  precision?: number;
  /** `decimal` only: digits after the decimal point. */
  scale?: number;
  /** A string `enum` stored as a PostgreSQL `ENUM` type instead of a `CHECK` constraint. */
  nativeEnum?: boolean;
  /** The column name, when it differs from the field name (top-level fields only). */
  column?: string;
  /**
   * With `ref` (top-level fields): what deleting the referenced row does to this one —
   * `'restrict'` (default) refuses the delete (409), `'cascade'` deletes this row too,
   * `'setNull'` clears the field. Enforced by a real foreign key.
   */
  onDelete?: ReferentialAction;
  /**
   * Item type for `array` fields. A scalar type becomes a native PostgreSQL array
   * (`text[]`, `integer[]`, …); a nested schema is stored as `jsonb`.
   */
  of?: TablePrimitiveFieldType | TableSchema;
  fields?: TableSchema;
}

/** `onDelete` behaviour of a `defineTable` foreign key. */
export type ReferentialAction = 'restrict' | 'cascade' | 'setNull';

export type TableSchemaField =
  | TableFieldDefinition
  | TableSchema
  | [TableSchema]
  | readonly [TableSchema];
export interface TableSchema {
  [field: string]: TableSchemaField;
}
export interface ModelSchema {
  [field: string]: SchemaField;
}

export type SortDirection = 1 | -1 | 'asc' | 'desc';

export interface ModelQueryOptions {
  /** Resolve `objectId` fields that have a `ref` into the referenced records. */
  populate?: string | string[];
  /** Only return these fields (`id` is always included). */
  select?: string[];
}

export interface FindOptions extends ModelQueryOptions {
  /** e.g. `{ createdAt: -1, name: 'asc' }` — keys are applied in order. */
  sort?: Record<string, SortDirection>;
  limit?: number;
  skip?: number;
}

export interface IndexDefinition {
  /** Field → direction (`1` / `-1`), or `'text'` for a full-text index. */
  fields: Record<string, 1 | -1 | 'text'>;
  unique?: boolean;
  /** MongoDB TTL index: documents expire this many seconds after the indexed date. */
  expireAfterSeconds?: number;
  name?: string;
}

export interface ModelOptions {
  /**
   * `true` (the default) adds `createdAt`/`updatedAt`; `false` disables both;
   * an object renames or selectively disables one, e.g.
   * `{ createdAt: 'created_at', updatedAt: false }`.
   */
  timestamps?: boolean | { createdAt?: string | false; updatedAt?: string | false };
  /** Compound, TTL and text indexes. Applied by `Model.sync()`. */
  indexes?: IndexDefinition[];
  /** Collection (MongoDB) or table (PostgreSQL) name. Default: mongoose's pluralised lowercase name. */
  collection?: string;
}

/** `defineTable` options: everything in `ModelOptions`, plus PostgreSQL-native keys and naming. */
export interface TableOptions extends ModelOptions {
  /**
   * Primary key: `'uuid'` (default, `gen_random_uuid()`), `'serial'` (an `integer` identity —
   * ids are `number`s) or `'bigserial'` (a `bigint` identity — ids are `bigint`s).
   */
  id?: 'uuid' | 'serial' | 'bigserial';
  /**
   * `'snake_case'` maps field names to snake_case columns (`createdAt` → `created_at`) and
   * the table name (`OrderItem` → `order_items`); records keep the field names. A field's
   * `column` overrides it. Default: columns are named like the fields.
   */
  naming?: 'snake_case';
  /**
   * Back-relations, loaded with `include`: records of another model that reference this one
   * through `foreignKey` — a `ref` field on that model (scalar, or a many-to-many array).
   * `hasOne` needs that field to be `unique`.
   *
   * @example relations: { comments: { hasMany: 'Comment', foreignKey: 'post' } }
   */
  relations?: Record<string, TableRelation>;
}

/** A back-relation of a `defineTable` model (see `TableOptions.relations`). */
export type TableRelation =
  | { hasMany: string; foreignKey: string; hasOne?: never }
  | { hasOne: string; foreignKey: string; hasMany?: never };

/** Comparison operators accepted in filters (the MongoDB query subset both engines support). */
export interface FilterOperators<V> {
  $eq?: V | null;
  $ne?: V | null;
  $gt?: V;
  $gte?: V;
  $lt?: V;
  $lte?: V;
  $in?: V[];
  $nin?: V[];
  $exists?: boolean;
  $regex?: string | RegExp;
}

type FilterValue<V> = V extends readonly (infer I)[]
  ? I | V | FilterOperators<I>
  : V | FilterOperators<V> | null;

/**
 * Query filter. Plain values match by equality (an array field matches if it contains
 * the value); operators cover comparisons; `$and` / `$or` combine; dotted paths
 * (`'address.city'`) reach into embedded objects. `id` maps to the primary key.
 */
export type Filter<T> = { [K in keyof T]?: FilterValue<T[K]> } & {
  id?: string | FilterOperators<string>;
  $and?: Filter<T>[];
  $or?: Filter<T>[];
  [dottedPath: `${string}.${string}`]: unknown;
};

/** Update document: plain fields (shorthand for `$set`) and/or update operators. */
export type Update<T> =
  | Partial<T>
  | {
      $set?: Partial<T> & { [dottedPath: `${string}.${string}`]: unknown };
      $unset?: { [K in keyof T]?: true | 1 | '' };
      $inc?: { [K in keyof T]?: number };
      $push?: { [K in keyof T]?: unknown };
      $pull?: { [K in keyof T]?: unknown };
    };

export type ModelRecord<T> = T & { id: string };

/** Fields of `T` that hold a single scalar value — the fields `distinct()` accepts. */
export type ScalarKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends string | number | bigint | boolean | Date ? K : never;
}[keyof T] &
  string &
  keyof T;

export interface ModelCRUD<T extends object, TCreate = Partial<T>> {
  readonly name: string;
  find(filter?: Filter<T>, options?: FindOptions): Promise<ModelRecord<T>[]>;
  findById(id: string, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>;
  findOne(filter: Filter<T>, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>;
  /** `true` if at least one record matches. */
  exists(filter: Filter<T>): Promise<boolean>;
  /**
   * The distinct non-null values of a scalar field among matching records, sorted
   * ascending. Array and object fields are rejected (the engines disagree on them).
   */
  distinct<K extends ScalarKeys<ModelRecord<T>>>(
    field: K,
    filter?: Filter<T>,
  ): Promise<NonNullable<ModelRecord<T>[K]>[]>;
  create(data: TCreate): Promise<ModelRecord<T>>;
  createMany(data: TCreate[]): Promise<ModelRecord<T>[]>;
  /** Validates changed fields (enum, min/max, custom validators) before writing. */
  update(id: string, data: Update<T>): Promise<ModelRecord<T> | null>;
  /**
   * Updates the first record matching `filter` (in one statement) and returns it, or
   * `null` if nothing matched. Which record is "first" is unspecified when several match.
   */
  updateOne(filter: Filter<T>, data: Update<T>): Promise<ModelRecord<T> | null>;
  /** Returns the number of records modified. */
  updateMany(filter: Filter<T>, data: Update<T>): Promise<number>;
  /**
   * Applies `update` to the first record matching `filter`, or creates `create` if none
   * matches; returns the resulting record. `create` is used as given — fields of `filter`
   * are not copied into it. Only a unique index on the filtered fields makes concurrent
   * upserts race-free: a duplicate (409) on create is retried once as an update.
   */
  upsert(filter: Filter<T>, create: TCreate, update: Update<T>): Promise<ModelRecord<T>>;
  delete(id: string): Promise<void>;
  /** Deletes the first record matching `filter` and returns it, or `null` if none matched. */
  deleteOne(filter: Filter<T>): Promise<ModelRecord<T> | null>;
  /** Returns the number of records deleted. */
  deleteMany(filter: Filter<T>): Promise<number>;
  count(filter?: Filter<T>): Promise<number>;
  /** MongoDB aggregation pipeline. Throws on PostgreSQL — use `db.query()` there. */
  aggregate<R = Record<string, unknown>>(pipeline: Record<string, unknown>[]): Promise<R[]>;
  /**
   * The engine-native object: the mongoose `Model` on MongoDB, the Drizzle `pgTable`
   * on PostgreSQL. Compiles the model if no query has run yet.
   */
  raw(): Promise<unknown>;
  /**
   * Reconciles the database with the model: creates the collection/table, adds missing
   * columns, converts changed column types, relaxes constraints the model dropped and
   * creates/removes indexes. Never drops a column or data. Runs automatically on first
   * use unless `autoSync: false`. Returns the changes made — or, with `dryRun`, the
   * changes it would make (SQL on PostgreSQL, index operations on MongoDB).
   */
  sync(options?: { dryRun?: boolean }): Promise<string[]>;
  /** Drops the collection/table and all its data. For migration `down()` functions. */
  drop(): Promise<void>;
}

// ── Type inference from the schema ───────────────────────────────────────────
// `defineModel('User', { ... })` derives its record and create-input types from the
// schema literal, so no interface has to be written (or kept in step) by hand.

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type PrimitiveValue<P> = P extends 'string' | 'objectId' | 'uuid' | 'decimal'
  ? string // decimal: exact, as a string
  : P extends 'number' | 'integer'
    ? number
    : P extends 'bigint'
      ? bigint
      : P extends 'boolean'
        ? boolean
        : P extends 'date'
          ? Date
          : unknown; // 'object' without `fields`, 'json': any JSON value

/** What a field accepts on writes: dates parse from strings, numbers widen exact types. */
type InputPrimitive<P> = P extends 'date'
  ? Date | string | number
  : P extends 'bigint'
    ? bigint | number
    : P extends 'decimal'
      ? string | number
      : PrimitiveValue<P>;

/** `I` = input mode (create data) instead of record mode. */
type InferDefinition<F, I extends boolean> = F extends { type: 'array' }
  ? F extends { of: infer O }
    ? O extends TablePrimitiveFieldType
      ? (I extends true ? InputPrimitive<O> : PrimitiveValue<O>)[]
      : InferObject<O, I>[]
    : unknown[]
  : F extends { type: 'object' }
    ? F extends { fields: infer S }
      ? InferObject<S, I>
      : unknown
    : F extends { enum: readonly (infer E)[] }
      ? E
      : F extends { type: infer P }
        ? I extends true
          ? InputPrimitive<P>
          : PrimitiveValue<P>
        : never;

type InferField<F, I extends boolean> = F extends readonly [infer S]
  ? InferObject<S, I>[]
  : F extends { type: TablePrimitiveFieldType | 'array' }
    ? InferDefinition<F, I>
    : InferObject<F, I>;

/** Fields always present on a stored record: required, defaulted or sequence-assigned. */
type PresentKeys<S> = {
  [K in keyof S]: S[K] extends
    | { required: true }
    | { default: unknown }
    | { sequence: true | string }
    ? K
    : never;
}[keyof S];

/** Fields a create call must supply: required, with no default and no sequence. */
type MandatoryKeys<S> = {
  [K in keyof S]: S[K] extends { required: true }
    ? S[K] extends { default: unknown } | { sequence: true | string }
      ? never
      : K
    : never;
}[keyof S];

type InferObject<S, I extends boolean> = I extends true
  ? Simplify<
      { -readonly [K in MandatoryKeys<S>]: InferField<S[K], true> } & {
        -readonly [K in Exclude<keyof S, MandatoryKeys<S>>]?: InferField<S[K], true> | undefined;
      }
    >
  : Simplify<
      { -readonly [K in PresentKeys<S>]: InferField<S[K], false> } & {
        -readonly [K in Exclude<keyof S, PresentKeys<S>>]?: InferField<S[K], false>;
      }
    >;

type TimestampName<O, K extends 'createdAt' | 'updatedAt'> = O extends { timestamps: false }
  ? never
  : O extends { timestamps: infer TS extends object }
    ? TS extends { [P in K]: infer N }
      ? N extends string
        ? N
        : never
      : K
    : K;

type TimestampFields<O> = {
  [P in TimestampName<O, 'createdAt'> | TimestampName<O, 'updatedAt'>]: Date;
};

/** The record type a schema describes (without `id`), incl. the timestamps `O` enables. */
export type InferSchema<S, O = object> = Simplify<InferObject<S, false> & TimestampFields<O>>;

/** The data `create()` accepts for a schema: required fields without a default are mandatory. */
export type InferCreateInput<S> = InferObject<S, true>;

/** The model type `defineModel` returns: explicit generic, inferred, or loose for a widened schema. */
export type InferredModel<T extends object, S, O> = [T] extends [never]
  ? string extends keyof S
    ? ModelCRUD<object> // schema typed as plain `ModelSchema` — nothing to infer from
    : ModelCRUD<InferSchema<S, O>, InferCreateInput<S>>
  : ModelCRUD<T>;

/**
 * The record type of a model, `id` included:
 * `type UserRecord = InferRecord<typeof User>`.
 */
export type InferRecord<M> = M extends { $types?: { record: infer R } }
  ? R
  : M extends ModelCRUD<infer T, unknown>
    ? Simplify<ModelRecord<T>>
    : never;

/** The data a model's `create()` accepts: `type NewUser = InferCreate<typeof User>`. */
export type InferCreate<M> = M extends { $types?: { create: infer C } }
  ? C
  : M extends { create(data: infer C): unknown }
    ? C
    : never;

/** Passed to migration `up`/`down` functions and seed functions. */
export interface MigrationContext {
  /** The native client: a mongoose `Connection` (MongoDB) or a node-postgres `Pool`. */
  db: unknown;
  engine: DatabaseEngine;
}
