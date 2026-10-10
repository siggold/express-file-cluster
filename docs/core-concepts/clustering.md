# Clustering

EFC uses Node's built-in `cluster` module to fork identical worker processes — one per CPU core by default. The OS load-balances incoming connections across them with no application-level proxy needed.

---

## How it works

```
              Master Process  (cluster.isPrimary)
         ┌────────────────────────────────────┐
         │  fork × N workers                  │
         │  respawn on 'exit'                 │
         └──┬──────────┬──────────┬───────────┘
            │          │          │
       Worker 1    Worker 2   Worker N
       Pre-Flight  Pre-Flight  Pre-Flight
       DB Connect  DB Connect  DB Connect
       Auth Config Auth Config Auth Config
       Scan Routes Scan Routes Scan Routes
       Reg. Tasks  Reg. Tasks  Reg. Tasks
       HTTP Listen HTTP Listen HTTP Listen
                 ↑
       OS round-robins connections
```

When `cluster: true` (or `NODE_ENV === 'production'` with no explicit value), `ignite()` checks `cluster.isPrimary`:

- **Primary** — calls `runMaster()`, forks workers, watches for exits, and returns `undefined`.
- **Worker** — runs the full Pre-Flight lifecycle, starts Express, and returns an `http.Server`.

---

## Pre-Flight lifecycle (per worker)

Every worker runs these steps in order before accepting any connections:

| Step | What happens |
|---|---|
| 0. Configure logging | Applies `logging` — every later line carries the worker label (`w<N>`). |
| 1. Connect Database | Establishes this worker's own connection pool to MongoDB or PostgreSQL, and selects what `defineModel` compiles to. |
| 2. Configure Auth | Wires the JWT secret, strategy, and cookie options into the auth module. |
| 3. Scan tasks | Walks `src/tasks/` and registers every `defineTask` export in the task registry. |
| 4. Start task backend | Connects BullMQ (Redis) or pg-boss (PostgreSQL), starts the queue worker and reconciles cron schedules. |
| 5. Scan routes | Walks `src/api/` and builds the `RouteEntry[]` array. |
| 6. Mount routes | Dynamically imports each route module and registers handlers on Express. |
| 7. Listen | Starts the HTTP server and logs `Worker <id> listening on :<port>`. |

Each worker owns its own database connection pool. There is no shared mutable state across workers.

---

## Configuration

```ts
ignite({
  // cluster defaults to NODE_ENV === 'production' — only pass it explicitly to
  // force one way regardless of NODE_ENV
  workers: 4,             // defaults to os.cpus().length
  onWorkerReady: (id) => console.log(`Worker ${id} ready`),
  onWorkerCrash: (id, code) => console.error(`Worker ${id} crashed (${code})`),
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cluster` | `boolean` | `true` when `NODE_ENV === 'production'` | Fork worker processes |
| `workers` | `number` | `os.cpus().length` | Number of workers to fork |
| `onWorkerReady` | `(id: number) => void` | — | Called when a worker comes online |
| `onWorkerCrash` | `(id: number, code: number) => void` | — | Called before a crashed worker is replaced |

---

## Self-healing

If a worker process exits (crash, unhandled rejection, OOM), the master:

1. Fires `onWorkerCrash(id, exitCode)`.
2. Immediately calls `cluster.fork()` to spawn a replacement.
3. The new worker runs the full Pre-Flight lifecycle before serving traffic.

The replacement is instantaneous from the master's perspective — there is no delay or exponential backoff. If workers crash in a tight loop (bad config, missing env var), the master keeps forking. Use `efc doctor` to diagnose configuration problems before deploying.

---

## Disabling clustering

Set `cluster: false` to run a single-process server. EFC forces clustering off in development (`efc start dev`) for faster restarts and cleaner stack traces.

```ts
ignite({ cluster: false });  // single process — same as efc start dev
```

---

## Graceful shutdown

`gracefulShutdown(server)` registers `SIGTERM` and `SIGINT` handlers:

```ts
import { ignite, gracefulShutdown } from 'express-file-cluster';

ignite(config)
  .then(gracefulShutdown);
```

- On a **worker**: calls `server.closeIdleConnections()`, then `server.close()` (in-flight requests finish), drains running task jobs, and exits `0`. Forces exit after a 10-second timeout. Repeated signals are ignored rather than killing it mid-drain.
- On the **primary** (when `ignite()` returns `undefined`): stops respawning, **relays `SIGTERM` to every worker** — orchestrators such as `docker stop` and Kubernetes signal only PID 1 — and exits once all workers have drained, or force-exits after the timeout + 2 s.

Pass a custom timeout (milliseconds) as the second argument:

```ts
gracefulShutdown(server, 30_000);  // 30-second drain window
```
