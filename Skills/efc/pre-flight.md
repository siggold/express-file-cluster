# EFC — Pre-Flight Lifecycle (Exact)

Source: `packages/core/src/index.ts` — `ignite()` function, worker branch.

This is the exact order of operations inside every worker process (or the single process when `cluster: false`).

---

## Step-by-step sequence

```
ignite() called
     │
     ├─ cluster.isPrimary && cluster enabled?
     │       YES → runMaster() → fork workers → return undefined (master exits here)
     │       NO  → continue as worker
     │
     ▼
0. configureLogger(config.logging)   (runs before the primary/worker split)

1. Create Express app
   - Wrap every request in an AsyncLocalStorage context
   - requestLogger(): X-Request-Id → req.id / req.log / getLogger(); one log line per response
   - requestTimeout → 408 middleware (if set)
   - Apply CORS middleware (from config.cors — ignite() never reads CORS_ORIGINS itself)
   - Apply express.json()
   - Apply express.urlencoded({ extended: true })
   - Apply cookieParser()
   - Apply globalMiddlewares[] (from config)

2. Connect Database  [database = config.database ?? scheme of databaseUrl]
   - setDbEngine(database)  → decides what defineModel compiles to (mongoose / Drizzle)
   - mongodb:    connectMongo(url) → setDbClient(mongoose.connection)
   - postgresql: connectPostgres(url) → pg Pool (+ Drizzle) → setDbClient(pool)
   - db proxy is now live. Models compile lazily on first use.

3. Configure Auth  [if jwtSecret is set]
   - configureAuth({ secret, strategy, expiresIn, cookieDomain? })
   - issueToken / requireAuth / signToken are now usable

4. Scan + Register Tasks  [src/tasks by convention — there is no tasksDir option]
   - scanTasks(tasksDir)
   - Walks tasksDir, imports each file, reads default export
   - Calls registerTask(basename, definition) for each valid TaskDefinition

5. Start Task Queue Backend  [if config.tasks is set]
   - backend === 'bullmq' → initBullMQ({ redisUrl, concurrency, enqueueTimeout, queue })
     - Queue(queue) with enableOfflineQueue: false; Worker(queue, processor)
     - cron schedulers reconciled in the BACKGROUND (Redis outage can't block boot)
   - backend === 'pg-boss' → initPgBoss({ connectionString ?? databaseUrl, ... })
     - one pg-boss queue per task: `<queue>.<Task>`; work() + schedule() per task
   - setEnqueueImpl(...) → enqueue() is now usable

6. Scan Routes
   - scanDir(apiDir) → RouteEntry[]
   - File → URL transformation (see routing-rules.md)
   - Per-segment specificity sort

7. Mount Routes
   - mountRoutes(app, routes)
   - Dynamic import of each route module
   - Register handlers on Express

8. Register error handler  [onError if provided, else built-in]

9. app.listen(port)
   - Resolves Promise<http.Server> on 'listening' event
   - Logs: Worker <id> listening on :<port>
```

---

## Key invariants

- **Steps 2–5 run BEFORE routes are mounted.** By the time a handler executes, `db` is live and `enqueue()` works.
- **Each worker runs all 8 steps independently.** Workers never share DB connections or task registry state.
- **`cluster: false` is identical** — the same 8 steps run in the single process, skipping the fork branch.
- **`cluster: true` + `cluster.isPrimary`** — the master process does NOTHING after `runMaster()`. It forks workers and watches `exit` events. It does not run Pre-Flight.

---

## `runMaster()` (cluster/index.ts)

```ts
runMaster({ workers, onWorkerReady, onWorkerCrash })
  → cluster.fork() × workers
  → cluster.on('online', worker => onWorkerReady?.(worker.id))
  → cluster.on('exit', (worker, code, signal) => {
      if (!isShuttingDown) {
        onWorkerCrash?.(worker.id, code ?? -1)
        cluster.fork()   // immediate respawn, no delay
      }
    })
```

The master never calls `app.listen()`. If `ignite()` is called in the primary process, it returns `undefined` — not a server.

---

## `gracefulShutdown()` — shutdown path

```
SIGTERM or SIGINT received
     │
     ├─ already shutting down? → ignore (repeat signals must not kill a draining worker)
     │
     ├─ server is defined (worker or single-process)
     │    → server.closeIdleConnections()
     │    → server.close(() => closeBullMQ() + closePgBoss() → process.exit(0))
     │    → setTimeout(force process.exit(1), timeoutMs)  // default 10s
     │
     └─ server is undefined (primary)
          → shutdownMaster(): isShuttingDown = true, SIGTERM relayed to every worker
            (docker stop / k8s only signal PID 1)
          → primary exits when all workers have; force-exit after timeoutMs + 2s
```

---

## Port resolution (exact precedence)

```
1. config.port  (if provided and not NaN)
2. 3000  (hardcoded default)
```

`ignite()` never reads `process.env.PORT` itself — pass it explicitly (typically via `efc.config.ts`: `port: process.env.PORT ? Number(process.env.PORT) : undefined`).

---

## Cluster enable/disable logic (exact)

```ts
const clusterEnabled = config.cluster ?? (process.env['NODE_ENV'] === 'production');
```

- `config.cluster` is `undefined` AND `NODE_ENV !== 'production'` → **clustering OFF** (dev default)
- `config.cluster` is `undefined` AND `NODE_ENV === 'production'` → **clustering ON**
- `config.cluster: true` → **ON** regardless of NODE_ENV
- `config.cluster: false` → **OFF** regardless of NODE_ENV

`efc start dev` sets `NODE_ENV=development` → clustering is automatically off in dev.
