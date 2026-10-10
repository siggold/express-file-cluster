import type { RequestHandler, ErrorRequestHandler } from 'express';

export type DatabaseEngine = 'mongodb' | 'postgresql';
export type AuthStrategy = 'http-only' | 'localStorage';
export type TaskBackend = 'bullmq' | 'pg-boss';

export interface TaskConfig {
  backend: TaskBackend;
  redisUrl?: string;
  concurrency?: number;
  /** Max milliseconds `enqueue()` waits for Redis before rejecting. Default: 5000. */
  enqueueTimeout?: number;
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

export interface MountedRoute extends RouteEntry {
  methods: string[];
  meta?: RouteMeta;
}

export interface TaskOptions {
  thread?: boolean;
  retries?: number;
  backoff?: 'fixed' | 'exponential';
  concurrency?: number;
  schedule?: string;
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
  /** A literal default value, or a `DefaultOperator` sentinel code (see above). */
  default?: unknown;
  /** Restricts the field to a fixed set of values. Valid on `string` and `number` types. */
  enum?: readonly (string | number)[];
  /** Mongoose model name to reference. Valid on `objectId` types (bare or as an array's `of`). */
  ref?: string;
  /** Item type for `array` fields, e.g. `{ type: 'array', of: 'string' }`. Omit for an untyped array. */
  of?: PrimitiveFieldType;
  /**
   * Auto-increments a shared counter (stored in an internal `efc_counters` collection)
   * and assigns it on insert, before `required` validation runs. `true` uses
   * `'<ModelName>.<field>'` as the counter key; a string sets an explicit key so
   * multiple fields/models can share one counter (e.g. a global order number).
   * Only supported on top-level fields — not inside nested array sub-schemas.
   */
  sequence?: boolean | string;
}

/**
 * A schema field is either a `FieldDefinition`, or a one-element tuple holding a nested
 * `ModelSchema` — the latter defines an array of embedded sub-documents, e.g.:
 * `route_progress: [{ route_id: { type: 'string' } }]`
 */
export type ModelSchema = Record<string, FieldDefinition | [ModelSchema]>;

export interface ModelQueryOptions {
  /** Mongoose `.populate()` path(s) to resolve on `objectId`/ref fields. */
  populate?: string | string[];
}

export interface ModelOptions {
  /**
   * Passed straight through to mongoose's own schema `timestamps` option.
   * `true` (the default) adds `createdAt`/`updatedAt`; `false` disables both;
   * an object lets you rename or selectively disable one, e.g.
   * `{ createdAt: 'created_at', updatedAt: false }`.
   */
  timestamps?: boolean | { createdAt?: string | false; updatedAt?: string | false };
}

export interface ModelCRUD<T extends object> {
  find(filter?: Partial<T>, options?: ModelQueryOptions): Promise<T[]>;
  findById(id: string, options?: ModelQueryOptions): Promise<(T & { id: string }) | null>;
  findOne(filter: Partial<T>, options?: ModelQueryOptions): Promise<(T & { id: string }) | null>;
  create(data: Partial<T>): Promise<T & { id: string }>;
  update(id: string, data: Partial<T>): Promise<(T & { id: string }) | null>;
  delete(id: string): Promise<void>;
  count(filter?: Partial<T>): Promise<number>;
}
