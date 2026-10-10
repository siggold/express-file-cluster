# EFC — Exact API Surface

Source of truth: `packages/core/src/`. Do not invent exports, types, or sub-paths not listed here.

---

## Sub-path exports

Three import paths. No others exist.

```ts
import { ... } from 'express-file-cluster'          // main
import { ... } from 'express-file-cluster/auth'      // auth module
import { ... } from 'express-file-cluster/tasks'     // tasks module
```

---

## `express-file-cluster` (main)

Source: `packages/core/src/index.ts`

### Functions & values

```ts
async function ignite(config: EFCConfig): Promise<http.Server | undefined> // undefined on the cluster primary
function gracefulShutdown(server: http.Server | undefined, timeoutMs?: number): void
function compose(...handlers: RequestHandler[]): RequestHandler

// Models — one API on MongoDB (mongoose) and PostgreSQL (Drizzle); engine picked at first use
function defineModel<T extends object>(name: string, schema: ModelSchema, options?: ModelOptions): ModelCRUD<T>
async function transaction<T>(fn: () => Promise<T>): Promise<T> // model calls inside join automatically
class ModelValidationError extends HttpError { issues: { path: string; message: string }[] } // status 400

// Native client from Pre-Flight: mongoose Connection (MongoDB) or pg Pool (PostgreSQL)
const db: AnyClient // Proxy — throws before Pre-Flight; methods are bound to the real client
function setDbClient(client: Record<string, unknown>): void
function getDbClient(): Record<string, unknown>

// Logging (pino)
const logger: Logger           // proxy for getLogger()
function getLogger(): Logger   // request-scoped child (carries reqId) inside a request, root otherwise

// Cache — needs ignite({ cache }); throws "Cache not configured" otherwise.
// Redis outage → get = undefined, set/del no-ops, wrap computes (never throws).
const cache: {
  get<T>(key): Promise<T | undefined>; set(key, value, { ttl?: seconds }?): Promise<void>;
  has(key): Promise<boolean>; del(...keys): Promise<number>;
  wrap<T>(key, ttlOrOptions, fn: () => Promise<T>): Promise<T>;  // in-process stampede dedupe
  clear(prefix?): Promise<number>;
}
function cacheResponse(ttl: number | { ttl; perUser?: boolean; key?: (req) => string }): RequestHandler
// GET/HEAD 200 JSON only; X-Cache: HIT|MISS; keys under 'res:' + originalUrl

function scanDir(dir: string, base?: string, maxDepth?: number): RouteEntry[]
function listTasks(): ReadonlyArray<{ name: string; options: TaskOptions }>
function workerCount(): number
class HttpError extends Error { readonly statusCode: number; static from(err, status?, fallback?): HttpError }
function isHttpError(value: unknown): value is HttpError
```

### Config types

```ts
interface EFCConfig {
  port?: number;                    // default 3000
  basePath?: string;                // default '/v1/api'
  dashboard?: boolean;              // dev-only route docs at '/'
  database?: 'mongodb' | 'postgresql'; // default: inferred from databaseUrl scheme
  databaseUrl?: string;
  authStrategy?: 'http-only' | 'localStorage';
  jwtSecret?: string;
  jwtExpiresIn?: string;            // default '7d'
  cookieDomain?: string;
  cluster?: boolean;                // default NODE_ENV === 'production'
  workers?: number;                 // default os.cpus().length
  tasks?: TaskConfig | false;
  cors?: boolean | CorsConfig;      // default true
  requestTimeout?: number;          // ms → 408
  logging?: LoggingConfig | false;
  cache?: { backend: 'redis'; url?: string; prefix?: string; timeout?: number }
        | { backend: 'memory'; prefix?: string; maxEntries?: number } | false;
  globalMiddlewares?: RequestHandler[];
  onWorkerReady?: (id: number) => void;
  onWorkerCrash?: (id: number, code: number) => void;
  onError?: ErrorRequestHandler;
}
// NOTE: there is NO apiDir / tasksDir option — src/api and src/tasks are found by convention.

interface TaskConfig {
  backend: 'bullmq' | 'pg-boss';
  redisUrl?: string;          // BullMQ, default redis://localhost:6379
  connectionString?: string;  // pg-boss, default databaseUrl
  schema?: string;            // pg-boss, default 'pgboss'
  concurrency?: number;       // default 5
  enqueueTimeout?: number;    // default 5000 ms — enqueue() rejects instead of hanging
  queue?: string;             // default 'efc'
}

interface LoggingConfig {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'; // default 'info'
  pretty?: boolean;   // default: non-production TTY
  requests?: boolean; // default true
}
```

### Route file exports

```ts
export const GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS = async (req, res) => {}
export const middlewares: RequestHandler[]
export const schema: RouteSchema   // { params?, query?, body? } or keyed by method
export const meta: RouteMeta       // dashboard docs, keyed by method

type Validator = { '~standard': { validate } } | { safeParse }  // Standard Schema (zod ≥3.24, valibot, arktype)
interface RequestSchema { params?: Validator; query?: Validator; body?: Validator }
type RouteSchema = RequestSchema | Partial<Record<string, RequestSchema>>
// Failure → 400 { error: 'Validation failed', statusCode: 400, issues: [{ location, path, message }] }
// Success → parsed output replaces req.params/query/body. Runs AFTER file middlewares.
```

`req.id` (request ID) and `req.log` (request logger) are added to Express's `Request` type.

### Model types

```ts
type PrimitiveFieldType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'objectId';

interface FieldDefinition {
  type: PrimitiveFieldType | 'array';
  required?: boolean; unique?: boolean; index?: boolean;
  default?: unknown;                         // literal, function, or DefaultOperator
  enum?: readonly (string | number)[];
  min?: number | Date; max?: number | Date;  // number, date
  minLength?: number; maxLength?: number;    // string
  match?: RegExp;                            // string
  validate?: (v: unknown) => boolean | string | Promise<boolean | string>; // string = error message
  ref?: string;                              // objectId / objectId arrays → populate
  of?: PrimitiveFieldType | ModelSchema;     // array item: primitive or embedded doc schema
  fields?: ModelSchema;                      // typed embedded object (type: 'object')
  sequence?: boolean | string;               // auto-increment; Mongo efc_counters / PG SEQUENCE
}

// A field: FieldDefinition | nested ModelSchema (embedded object shorthand) | [ModelSchema] (array of embedded docs)
type SchemaField = FieldDefinition | ModelSchema | [ModelSchema];
interface ModelSchema { [field: string]: SchemaField }

type DefaultOperator = '$now' | '$uuid' | '$objectId' | '$timestamp' | '$shortId' | '$currentUser' | `$currentUser.${string}`;
// '$increment' is NOT an operator — use `sequence`.

interface ModelOptions {
  timestamps?: boolean | { createdAt?: string | false; updatedAt?: string | false }; // default true
  indexes?: { fields: Record<string, 1 | -1 | 'text'>; unique?: boolean; expireAfterSeconds?: number; name?: string }[];
  collection?: string; // collection/table name, default lowercase plural of the model name
}

interface FindOptions { populate?: string | string[]; select?: string[]; sort?: Record<string, 1 | -1 | 'asc' | 'desc'>; limit?: number; skip?: number }

// Filter<T>: equality (array fields: contains), $eq $ne $gt $gte $lt $lte $in $nin $exists $regex,
//            $and / $or, dotted paths ('address.city'), `id` for the primary key. Typed — no casts.
// Update<T>: plain fields (= $set) and/or $set (dotted ok) $inc $push ({$each}) $pull $unset.

interface ModelCRUD<T> {
  readonly name: string;
  find(filter?: Filter<T>, options?: FindOptions): Promise<ModelRecord<T>[]>;
  findById(id: string, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>; // malformed id → null
  findOne(filter: Filter<T>, options?: ModelQueryOptions): Promise<ModelRecord<T> | null>;
  create(data: Partial<T>): Promise<ModelRecord<T>>;
  createMany(data: Partial<T>[]): Promise<ModelRecord<T>[]>;
  update(id: string, data: Update<T>): Promise<ModelRecord<T> | null>;  // VALIDATES changed fields
  updateMany(filter: Filter<T>, data: Update<T>): Promise<number>;
  delete(id: string): Promise<void>;
  deleteMany(filter: Filter<T>): Promise<number>;
  count(filter?: Filter<T>): Promise<number>;
  aggregate<R>(pipeline: object[]): Promise<R[]>;  // MongoDB only — rejects on PostgreSQL
  raw(): Promise<unknown>;                          // mongoose Model / Drizzle pgTable
  sync(): Promise<void>;                            // create table/collection, add columns, indexes — never drops
  drop(): Promise<void>;
}
type ModelRecord<T> = T & { id: string };
// Errors: ModelValidationError (400, issues), duplicate unique → HttpError 409.

interface MigrationContext { db: unknown; engine: 'mongodb' | 'postgresql' } // passed to up/down/seed
```

---

## `express-file-cluster/auth`

Source: `packages/core/src/auth/index.ts`

```ts
// Set cookie (http-only strategy)
async function issueToken(res: Response, payload: Record<string, unknown>): Promise<void>

// Clear cookie (http-only strategy)
function revokeToken(res: Response): void

// Return token string (localStorage strategy)
async function signToken(payload: Record<string, unknown>): Promise<string>

// Need ignite({ cache }). Every signed token carries jti + iat + efc_iat (ms).
async function revokeSession(req: Request, res?: Response): Promise<void>   // denylist this token until exp
async function revokeAllSessions(userId: string | number): Promise<void>     // reject tokens issued before now

// Express middleware — verifies JWT, attaches payload to req.user.
// Dual-purpose: bare it's just auth; called with role names it returns a
// middleware that also enforces payload.role (403 if it doesn't match).
interface RequireAuth {
  (req: Request, res: Response, next: NextFunction): void;
  (...roles: string[]): RequestHandler;
}
const requireAuth: RequireAuth

// Internal — called by ignite()
function configureAuth(config: { secret: string; strategy: AuthStrategy; expiresIn: string; cookieDomain?: string }): void

// Reads the JWT payload requireAuth attached to the in-flight request, from
// anywhere in the async call chain (backed by AsyncLocalStorage — see context.ts).
// Returns undefined outside a request, or on a route that never ran requireAuth.
// Also what powers the '$currentUser'/'$currentUser.<key>' defineModel default codes.
function getCurrentUser(): Record<string, unknown> | undefined
```

Cookie name: `efc_token`. Algorithm: HS256. Library: `jose`.

Every request run through `ignite()` is wrapped in its own `AsyncLocalStorage` context (`packages/core/src/context.ts`) before any other middleware runs; `requireAuth` populates it with the verified JWT payload. This DOES exist now — it's no longer accurate to say EFC has no request context (see `what-not-to-invent.md`, which has been updated).

---

## `express-file-cluster/tasks`

Source: `packages/core/src/tasks/index.ts`

```ts
function defineTask<T>(handler: (payload: T) => Promise<void>): TaskDefinition<T>
function defineTask<T>(options: TaskOptions, handler: (payload: T) => Promise<void>): TaskDefinition<T>

// Rejects: backend not configured | unknown task | backend unreachable within tasks.enqueueTimeout
async function enqueue<T>(name: string, payload: T): Promise<void>

interface TaskOptions {
  thread?: boolean;                    // run in worker_threads
  retries?: number;                    // re-runs; up to retries + 1 attempts. Default 3
  backoff?: 'fixed' | 'exponential';   // 1 s base. Default 'exponential'
  concurrency?: number;
  schedule?: string;                   // cron; scheduled runs get payload {}
  timezone?: string;                   // IANA tz for schedule
}

// Internal
function registerTask(name: string, def: TaskDefinition): void
function setEnqueueImpl(impl: (name: string, payload: unknown) => Promise<void>): void
const taskRegistry: Map<string, TaskDefinition>
function listTasks(): ReadonlyArray<{ name: string; options: TaskOptions }>
```

---

## `ignite()` does NOT read app config from `process.env` — `NODE_ENV` is the one exception

`ignite()` never reads `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_DOMAIN`, or `CORS_ORIGINS` itself. Each must be passed explicitly in the `EFCConfig` object — the scaffolder generates an `efc.config.ts` that reads `process.env.X` for each of these and builds that object; `src/index.ts` just spreads it into `ignite()`. See `what-not-to-invent.md` for the full "does not auto-read" list.

| Config field | Typically wired from | Fallback if unset |
|---|---|---|
| `port` | `process.env.PORT` | `3000` |
| `databaseUrl` | `process.env.DATABASE_URL` | none (no DB connects) |
| `jwtSecret` | `process.env.JWT_SECRET` | none (auth disabled) |
| `jwtExpiresIn` | `process.env.JWT_EXPIRES_IN` | `'7d'` |
| `cookieDomain` | `process.env.COOKIE_DOMAIN` | unset (host-only cookie) |
| `cors.origin` | `process.env.CORS_ORIGINS?.split(',')` | `true` (allow all) |
| `tasks.redisUrl` | `process.env.REDIS_URL` | `'redis://localhost:6379'` |
| `tasks.connectionString` (pg-boss) | — | `databaseUrl` |

`NODE_ENV` is the sole exception — a Node/Express-wide runtime-mode signal, not an app secret — and is still read directly via `process.env['NODE_ENV']` in three places: `ignite()`'s cluster-in-production default, the dev-only dashboard toggle, and the `http-only` auth strategy's cookie `Secure` flag.
