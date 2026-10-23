import type http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';
import type { EFCConfig, MountedRoute } from './types.js';
export type {
  TableModel,
  TableRecord,
  TableCreateInput,
  TableWhere,
  TableWhereUnique,
  TableUpdateData,
  TableCreateData,
  TableUpdateInput,
  TableOrderBy,
  TableSelect,
  TableInclude,
  TableResult,
  Tables,
  TableFindManyArgs,
  TableAggregateArgs,
  TableGroupByArgs,
  TableAggregateResult,
  ScalarFilter,
  StringFilter,
  ListFilter,
  JsonFilter,
  InferTableRecord,
} from './table-types.js';
import { scanDir } from './router/scan.js';
import { mountRoutes } from './router/mount.js';
import { runMaster, shutdownMaster } from './cluster/index.js';
import { configureAuth } from './auth/index.js';
import { isHttpError } from './errors.js';
import { connectMongo } from './db/mongo.js';
import { setDbClient } from './db/index.js';
import { setDbEngine, setAutoSync } from './db/engine.js';
import { connectPostgres } from './db/postgres.js';
import { runWithContext } from './context.js';
import { configureLogger, getLogger, requestLogger } from './logger.js';
import { configureQueryLog } from './db/query-log.js';
import { scanTasks } from './tasks/scanner.js';
import { initBullMQ, closeBullMQ } from './tasks/bullmq-backend.js';
import { initPgBoss, closePgBoss } from './tasks/pgboss-backend.js';
import { configureCache, closeCache } from './cache/index.js';
import { servePrimaryCache } from './cache/ipc.js';
import { generateDashboard } from './dashboard.js';

function detectDatabase(url?: string): 'mongodb' | 'postgresql' | undefined {
  if (!url) return undefined;
  if (url.startsWith('mongodb')) return 'mongodb';
  if (url.startsWith('postgres')) return 'postgresql';
  return undefined;
}

export async function ignite(config: EFCConfig): Promise<http.Server | undefined> {
  const {
    port: _port,
    workers,
    globalMiddlewares = [],
    onWorkerReady,
    onWorkerCrash,
    onError,
  } = config;

  // Resolve api/tasks dirs from convention. argv[1]-based resolution is unreliable in tsx watch
  // + cluster workers (argv[1] can point to the tsx binary instead of the user's script), so we
  // probe multiple candidates and use the first that exists on disk.
  function resolveConventionDir(name: string): string {
    const candidates: string[] = [
      ...(process.argv[1] ? [path.join(path.dirname(process.argv[1]), name)] : []),
      path.join(process.cwd(), 'src', name),
      path.join(process.cwd(), name),
      path.join(process.cwd(), 'dist', name),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
  }
  const apiDir = resolveConventionDir('api');
  const tasksDir = resolveConventionDir('tasks');
  const basePath = config.basePath ?? '/v1/api';

  function readProjectMeta(): { name: string; version: string } {
    try {
      const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      return { name: pkg.name ?? 'API', version: pkg.version ?? '' };
    } catch {
      return { name: 'API', version: '' };
    }
  }

  const port = _port != null && !Number.isNaN(_port) ? _port : 3000;
  const databaseUrl = config.databaseUrl;
  const database = config.database ?? detectDatabase(databaseUrl);
  const jwtSecret = config.jwtSecret;
  const authStrategy = config.authStrategy ?? 'http-only';
  // NODE_ENV is a Node/Express-wide runtime-mode signal set by the platform, not an app
  // secret — unlike PORT/DATABASE_URL/JWT_SECRET/etc. this one is still read directly.
  const clusterEnabled = config.cluster ?? process.env['NODE_ENV'] === 'production';

  configureLogger(config.logging);
  configureQueryLog(config.logging);

  if (clusterEnabled && cluster.isPrimary) {
    // The memory cache lives in the primary so all workers share it (cache/ipc.ts).
    if (config.cache && config.cache.backend === 'memory') {
      servePrimaryCache(config.cache.maxEntries ?? 10_000);
    }
    runMaster({
      workers: workers ?? os.cpus().length,
      ...(onWorkerReady !== undefined && { onWorkerReady }),
      ...(onWorkerCrash !== undefined && { onWorkerCrash }),
    });
    return;
  }

  const app = express();
  // defineTable returns `bigint` for bigint columns and bigserial ids, which JSON.stringify
  // rejects; send them as strings (exact — a JS number would lose precision past 2^53).
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  // Wraps every request in its own AsyncLocalStorage context, first thing, so
  // requireAuth (below) and any downstream code — including a `$currentUser`
  // default resolved inside a mongoose `.create()` call — share the same store.
  app.use((_req, _res, next) => {
    runWithContext({}, next);
  });
  app.use(requestLogger());

  if (config.requestTimeout) {
    const ms = config.requestTimeout;
    app.use((_req, res, next) => {
      const timer = setTimeout(() => {
        if (!res.headersSent) res.status(408).json({ error: 'Request Timeout', statusCode: 408 });
      }, ms);
      const clear = () => clearTimeout(timer);
      res.once('finish', clear);
      res.once('close', clear);
      next();
    });
  }

  const corsOption = config.cors ?? true;
  if (corsOption !== false) {
    const origin =
      typeof corsOption === 'object' && corsOption.origin !== undefined ? corsOption.origin : true;
    const corsOpts = typeof corsOption === 'object' ? { ...corsOption, origin } : { origin };
    app.use(cors(corsOpts));
  }

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  for (const mw of globalMiddlewares) {
    app.use(mw);
  }

  // Pre-Flight step 1: Connect database. The engine decides what defineModel compiles to.
  if (database) setDbEngine(database);
  setAutoSync(config.autoSync ?? true);
  if (database === 'mongodb' && databaseUrl) {
    const conn = await connectMongo(databaseUrl, config.databasePool);
    setDbClient(conn as unknown as Record<string, unknown>);
  } else if (database === 'postgresql' && databaseUrl) {
    const pool = await connectPostgres(databaseUrl, config.databasePool);
    setDbClient(pool as unknown as Record<string, unknown>);
  }

  // Pre-Flight step 1b: Cache (also the session-revocation store requireAuth consults)
  if (config.cache) {
    await configureCache(config.cache);
  }

  // Pre-Flight step 2: Configure auth
  if (jwtSecret) {
    configureAuth({
      secret: jwtSecret,
      strategy: authStrategy,
      expiresIn: config.jwtExpiresIn ?? '7d',
      ...(config.cookieDomain !== undefined && { cookieDomain: config.cookieDomain }),
    });
  }

  // Pre-Flight step 3: Scan and register tasks
  if (tasksDir) {
    await scanTasks(tasksDir);
  }

  // Pre-Flight step 4: Start task queue backend
  if (config.tasks) {
    if (config.tasks.backend === 'bullmq') {
      await initBullMQ({
        redisUrl: config.tasks.redisUrl ?? 'redis://localhost:6379',
        concurrency: config.tasks.concurrency ?? 5,
        enqueueTimeout: config.tasks.enqueueTimeout ?? 5000,
        queue: config.tasks.queue ?? 'efc',
      });
    } else if (config.tasks.backend === 'pg-boss') {
      const connectionString = config.tasks.connectionString ?? databaseUrl;
      if (!connectionString) {
        throw new Error(
          '[EFC] tasks.backend "pg-boss" needs tasks.connectionString or databaseUrl',
        );
      }
      await initPgBoss({
        connectionString,
        concurrency: config.tasks.concurrency ?? 5,
        enqueueTimeout: config.tasks.enqueueTimeout ?? 5000,
        queue: config.tasks.queue ?? 'efc',
        ...(config.tasks.schema !== undefined && { schema: config.tasks.schema }),
      });
    }
  }

  // Pre-Flight step 5: Scan routes and mount
  const routes = scanDir(apiDir);
  const apiRouter = express.Router();
  const mounted: MountedRoute[] = await mountRoutes(apiRouter, routes);
  app.use(basePath, apiRouter);

  if (config.dashboard !== false && process.env['NODE_ENV'] === 'development') {
    app.get('/', (_req, res) => {
      const { name, version } = readProjectMeta();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(generateDashboard(mounted, basePath, port, name, version));
    });
  }

  if (onError) {
    app.use(onError);
  } else {
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        // e.g. a handler that kept going after requestTimeout already answered 408.
        if (res.headersSent) {
          getLogger().warn({ err }, 'Error after the response was sent');
          return;
        }
        // isHttpError() covers the common case, but errors can also arrive as plain
        // objects with a numeric statusCode (e.g. thrown across a module boundary, or
        // duck-typed by user code) — fall back to that shape before giving up to 500.
        const duckTyped =
          err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number'
            ? (err as Error & { statusCode: number })
            : null;

        if (isHttpError(err)) {
          // ModelValidationError carries per-field issues; surface them like route validation does.
          const issues = (err as { issues?: unknown }).issues;
          res.status(err.statusCode).json({
            error: err.message,
            statusCode: err.statusCode,
            ...(issues !== undefined && { issues }),
          });
        } else if (duckTyped) {
          res
            .status(duckTyped.statusCode)
            .json({ error: duckTyped.message, statusCode: duckTyped.statusCode });
        } else {
          getLogger().error({ err }, 'Unhandled error');
          res.status(500).json({ error: 'Internal Server Error', statusCode: 500 });
        }
      },
    );
  }

  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port);

    server.once('listening', () => {
      const wid = (cluster.worker as { id: number } | undefined)?.id ?? 'primary';
      const addr = server.address() as { port: number } | null;
      getLogger().info(`Worker ${wid} listening on :${addr?.port ?? port}`);
      resolve(server);
    });

    server.once('error', reject);
  });
}

export function gracefulShutdown(server: http.Server | undefined, timeoutMs = 10_000): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // A worker can get the signal twice (process-group Ctrl+C plus the primary's
    // forward); the default handler for a repeat would kill it mid-drain.
    if (shuttingDown) return;
    shuttingDown = true;
    getLogger().info(`${signal} received — closing server gracefully…`);
    if (server) {
      server.closeIdleConnections();
      server.close(() => {
        getLogger().info('Server closed');
        // Let in-flight task jobs finish before exiting; the timeout below still caps it.
        Promise.all([closeBullMQ(), closePgBoss(), closeCache()])
          .catch((err: unknown) => getLogger().error({ err }, 'Task backend close failed'))
          .finally(() => process.exit(0));
      });
      setTimeout(() => {
        getLogger().error('Forced exit after timeout');
        process.exit(1);
      }, timeoutMs).unref();
    } else {
      shutdownMaster();
      // Workers get the same budget plus a margin before the primary gives up on them.
      setTimeout(() => {
        getLogger().error('Workers did not exit in time — forcing primary exit');
        process.exit(1);
      }, timeoutMs + 2_000).unref();
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { HttpError, isHttpError } from './errors.js';
export { logger, getLogger } from './logger.js';
export { cache } from './cache/index.js';
export { cacheResponse } from './cache/response.js';
export { compose } from './compose.js';
export { db, setDbClient, getDbClient, defineModel, defineTable } from './db/index.js';
export { transaction } from './db/transaction.js';
export { ModelValidationError } from './db/schema.js';
export { scanDir } from './router/scan.js';
export { listTasks } from './tasks/index.js';
export { workerCount } from './cluster/index.js';
export type {
  EFCConfig,
  DatabasePoolConfig,
  CorsConfig,
  RouteEntry,
  RouteMeta,
  RouteMethodMeta,
  RouteSchema,
  LoggingConfig,
  QueryLogConfig,
  CacheConfig,
  RequestSchema,
  Validator,
  ValidationIssue,
  TaskOptions,
  TaskDefinition,
  DatabaseEngine,
  AuthStrategy,
  ModelSchema,
  TableSchema,
  TableSchemaField,
  TableFieldDefinition,
  TableOptions,
  TableRelation,
  MigrationContext,
  SchemaField,
  Filter,
  FilterOperators,
  Update,
  FindOptions,
  IndexDefinition,
  ModelRecord,
  InferRecord,
  InferCreate,
  InferSchema,
  InferCreateInput,
  ScalarKeys,
  SortDirection,
  ModelCRUD,
  ModelQueryOptions,
  ModelOptions,
  FieldDefinition,
  DefaultOperator,
} from './types.js';
