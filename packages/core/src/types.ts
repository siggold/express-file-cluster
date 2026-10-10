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

export interface LoggingConfig {
  /** Minimum level to emit. Default: 'info'. */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** Human-readable lines instead of JSON. Default: on in a non-production TTY. */
  pretty?: boolean;
  /** Log one line per completed request (method, url, status, duration). Default: true. */
  requests?: boolean;
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
  /** Model name to reference. Valid on `objectId` types (bare or as an array's `of`). */
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
}

/**
 * A schema field is one of:
 * - a `FieldDefinition` (`{ type: 'string', required: true }`)
 * - a nested `ModelSchema` — shorthand for an embedded object with typed fields:
 *   `address: { city: { type: 'string' }, zip: { type: 'string' } }`
 * - a one-element tuple holding a nested `ModelSchema` — an array of embedded
 *   documents: `items: [{ sku: { type: 'string' } }]`
 */
export type SchemaField = FieldDefinition | ModelSchema | [ModelSchema];
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

export interface ModelCRUD<T extends object> {
  readonly name: string;
  find(filter?: Filter<T>, options?: FindOptions): Promise<ModelRecord<T>[]>;
  findById(id: string, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>;
  findOne(filter: Filter<T>, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>;
  create(data: Partial<T>): Promise<ModelRecord<T>>;
  createMany(data: Partial<T>[]): Promise<ModelRecord<T>[]>;
  /** Validates changed fields (enum, min/max, custom validators) before writing. */
  update(id: string, data: Update<T>): Promise<ModelRecord<T> | null>;
  /** Returns the number of records modified. */
  updateMany(filter: Filter<T>, data: Update<T>): Promise<number>;
  delete(id: string): Promise<void>;
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
   * Creates the collection/table, any missing columns, and indexes — never drops or
   * alters existing data. Call it from a migration (`efc db migrate`).
   */
  sync(): Promise<void>;
}
