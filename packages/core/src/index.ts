import type http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';
import type { EFCConfig, MountedRoute } from './types.js';
import { scanDir } from './router/scan.js';
import { mountRoutes } from './router/mount.js';
import { runMaster, shutdownMaster } from './cluster/index.js';
import { configureAuth } from './auth/index.js';
import { isHttpError } from './errors.js';
import { connectMongo } from './db/mongo.js';
import { setDbClient } from './db/index.js';
import { runWithContext } from './context.js';
import { scanTasks } from './tasks/scanner.js';
import { initBullMQ, closeBullMQ } from './tasks/bullmq-backend.js';
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

  if (clusterEnabled && cluster.isPrimary) {
    runMaster({
      workers: workers ?? os.cpus().length,
      ...(onWorkerReady !== undefined && { onWorkerReady }),
      ...(onWorkerCrash !== undefined && { onWorkerCrash }),
    });
    return;
  }

  const app = express();

  // Wraps every request in its own AsyncLocalStorage context, first thing, so
  // requireAuth (below) and any downstream code — including a `$currentUser`
  // default resolved inside a mongoose `.create()` call — share the same store.
  app.use((_req, _res, next) => {
    runWithContext({}, next);
  });

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

  // Pre-Flight step 1: Connect database
  if (database === 'mongodb' && databaseUrl) {
    const conn = await connectMongo(databaseUrl);
    setDbClient(conn as unknown as Record<string, unknown>);
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
        // isHttpError() covers the common case, but errors can also arrive as plain
        // objects with a numeric statusCode (e.g. thrown across a module boundary, or
        // duck-typed by user code) — fall back to that shape before giving up to 500.
        const duckTyped =
          err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number'
            ? (err as Error & { statusCode: number })
            : null;

        if (isHttpError(err)) {
          res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
        } else if (duckTyped) {
          res.status(duckTyped.statusCode).json({ error: duckTyped.message, statusCode: duckTyped.statusCode });
        } else {
          console.error('[EFC] Unhandled error:', err);
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
      console.log(`[EFC] Worker ${wid} listening on :${addr?.port ?? port}`);
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
    console.log(`[EFC] ${signal} received — closing server gracefully…`);
    if (server) {
      server.closeIdleConnections();
      server.close(() => {
        console.log('[EFC] Server closed');
        // Let in-flight task jobs finish before exiting; the timeout below still caps it.
        closeBullMQ()
          .catch((err: unknown) => console.error('[EFC] Task backend close failed:', err))
          .finally(() => process.exit(0));
      });
      setTimeout(() => {
        console.error('[EFC] Forced exit after timeout');
        process.exit(1);
      }, timeoutMs).unref();
    } else {
      shutdownMaster();
      // Workers get the same budget plus a margin before the primary gives up on them.
      setTimeout(() => {
        console.error('[EFC] Workers did not exit in time — forcing primary exit');
        process.exit(1);
      }, timeoutMs + 2_000).unref();
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { HttpError, isHttpError } from './errors.js';
export { compose } from './compose.js';
export { db, setDbClient, getDbClient, defineModel } from './db/index.js';
export { scanDir } from './router/scan.js';
export { listTasks } from './tasks/index.js';
export { workerCount } from './cluster/index.js';
export type {
  EFCConfig,
  CorsConfig,
  RouteEntry,
  RouteMeta,
  RouteMethodMeta,
  TaskOptions,
  TaskDefinition,
  DatabaseEngine,
  AuthStrategy,
  ModelSchema,
  ModelCRUD,
  ModelQueryOptions,
  ModelOptions,
  FieldDefinition,
  DefaultOperator,
} from './types.js';
