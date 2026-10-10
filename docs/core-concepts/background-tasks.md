# Background Tasks

The `src/tasks/` directory holds background jobs — work that should run *after* the HTTP response is sent, with retries, backoff, and concurrency control. The file name (without extension) is the task name used with `enqueue()`.

---

## Why background tasks?

Two workloads hide behind "do this work":

| Workload | Example | How EFC runs it |
|---|---|---|
| **I/O-bound** | Send email, call a webhook, write to S3 | Queue → async handler on the event loop |
| **CPU-bound** | Resize an image, transcode video, parse a large file | Queue → `worker_threads` thread |

EFC does not hand-roll the queue. Persistence, retries, backoff, dead-lettering, scheduling and concurrency are delegated to a proven backend: **BullMQ** (Redis) or **pg-boss** (PostgreSQL — no Redis needed). Task code is identical on both.

---

## Defining a task

### I/O-bound task

```ts
// src/tasks/SendEmail.ts
import { defineTask } from 'express-file-cluster/tasks';

interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
}

export default defineTask<SendEmailPayload>(async ({ to, subject, body }) => {
  await mailer.send({ to, subject, body });
});
```

> The `create-efc-app` scaffolder generates a real, working version of this file (using `nodemailer` + your configured SMTP credentials) when you enable the **Mailer** option — see [Mailer](../guides/mailer.md).

### CPU-bound task

Pass `{ thread: true }` as the first argument. The handler runs in a dedicated `worker_threads` thread, keeping the event loop free.

```ts
// src/tasks/ResizeImage.ts
import { defineTask } from 'express-file-cluster/tasks';
import sharp from 'sharp';

interface ResizePayload {
  key: string;
  width: number;
}

export default defineTask<ResizePayload>(
  { thread: true },
  async ({ key, width }) => {
    const input = await downloadFromStorage(key);
    const out = await sharp(input).resize(width).toBuffer();
    await uploadToStorage(`${key}@${width}`, out);
  },
);
```

---

## Task options

| Option | Type | Default | Description |
|---|---|---|---|
| `thread` | `boolean` | `false` | Run in a `worker_threads` thread (CPU-bound work) |
| `retries` | `number` | `3` | Re-runs after a failure (up to `retries + 1` attempts) before dead-lettering |
| `backoff` | `'fixed' \| 'exponential'` | `'exponential'` | Delay strategy between retries (1 s base) |
| `concurrency` | `number` | inherits `tasks.concurrency` | Parallel jobs for this specific task |
| `schedule` | `string` | — | Cron pattern for recurring runs, e.g. `'0 3 * * *'` |
| `timezone` | `string` | server time | IANA timezone for `schedule`, e.g. `'Europe/Berlin'` |

---

## Scheduled (cron) tasks

```ts
// src/tasks/NightlyReport.ts
import { defineTask } from 'express-file-cluster/tasks';

export default defineTask({ schedule: '0 3 * * *', timezone: 'UTC' }, async () => {
  await buildAndEmailReport();
});
```

Scheduled runs receive `{}` as the payload and get the same retries as enqueued jobs; the task can still be `enqueue()`d manually too. Schedules are reconciled on every boot: each cluster worker upserts them idempotently (no duplicate runs), and schedules for tasks that lost their `schedule` — or were deleted — are removed. BullMQ accepts a 6-field pattern with seconds; pg-boss's cron resolution is one minute.

---

## Enqueuing a task from a route

```ts
// src/api/users/index.ts
import type { Request, Response } from 'express';
import { enqueue } from 'express-file-cluster/tasks';
import { User } from '../../model/User.js';

export const POST = async (req: Request, res: Response) => {
  const user = await User.create(req.body);

  // Fire-and-forget — respond immediately, job runs off-path
  await enqueue('SendEmail', {
    to: user.email,
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });

  res.status(202).json({ id: user.id, queued: true });
};
```

`enqueue(name, payload)` rejects if:
- The task backend has not been initialised (missing `tasks` config in `ignite()`).
- The task name was not found in the registry (file not in `src/tasks/`, or bad default export).
- Redis did not accept the job within `tasks.enqueueTimeout` (default 5000 ms). The request fails fast instead of hanging, and the rejected job is not silently queued later.

---

## Task registration

On startup, the task scanner walks `src/tasks/` (non-recursively) and:

1. Reads each `.ts` / `.js` file.
2. Imports the module and reads the `default` export.
3. Validates that `default.handler` is a function.
4. Calls `registerTask(basename, definition)` to add it to the in-memory registry.

The task's `filePath` is stored so `thread: true` tasks can be loaded by the `worker_threads` runner without re-importing the module in the main thread.

---

## BullMQ backend

When `tasks.backend === 'bullmq'`, `initBullMQ()` in `packages/core/src/tasks/bullmq-backend.ts`:

1. Dynamically imports `bullmq` (peer dependency — not bundled).
2. Creates a `Queue` named `tasks.queue` (default `'efc'`) connected to Redis.
3. Creates a `Worker` on that queue with the configured `concurrency`, and reconciles cron schedulers in the background (a Redis outage at boot doesn't block the HTTP server).
4. The worker's processor looks up the task in the registry and either:
   - Calls `def.handler(job.data)` directly (I/O-bound), or
   - Calls `runInThread(def.filePath, job.data)` (CPU-bound).
5. Wires `setEnqueueImpl` so `enqueue()` calls `queue.add(name, payload, { attempts: retries + 1, backoff })`, bounded by `enqueueTimeout`.

On shutdown, `gracefulShutdown()` closes the HTTP server first, then lets the worker finish in-flight jobs before the process exits (still capped by its timeout).

### Redis connection

The `REDIS_URL` env var (or `tasks.redisUrl` in `ignite()`) is parsed by the built-in `parseRedisUrl` helper. It supports `redis://[user:password@]host[:port][/db]` and `rediss://` (TLS) URLs, so hosted Redis with ACL users and TLS (Upstash, Redis Cloud, ElastiCache) works as-is.

```ts
ignite({
  tasks: {
    backend: 'bullmq',
    redisUrl: process.env.REDIS_URL,  // or omit — defaults to redis://localhost:6379
    concurrency: 5,
    enqueueTimeout: 5000, // ms — enqueue() rejects instead of hanging when Redis is down
    queue: 'efc',         // apps sharing one Redis database need distinct names
  },
});
```

---

## pg-boss backend

For PostgreSQL stacks that don't want to run Redis:

```bash
npm install pg-boss
```

```ts
ignite({
  databaseUrl: process.env.DATABASE_URL,
  tasks: {
    backend: 'pg-boss',
    // connectionString: '…', // default: databaseUrl
    // schema: 'pgboss',      // where pg-boss keeps its tables
    concurrency: 5,
  },
});
```

pg-boss stores jobs in your Postgres (its own `pgboss` schema, created on first start). Each task becomes a pg-boss queue named `<tasks.queue>.<TaskName>`; retries, backoff, cron, graceful drain on shutdown and `enqueueTimeout` behave as with BullMQ. Any payload works — pg-boss requires objects, so other values are boxed transparently.

---

## Dead letters

A job that exhausts its retries stays in the backend's failed set. Inspect and act on it from any shell:

```bash
efc tasks failed               # list (with error, attempts, payload) + queue counts
efc tasks failed --name SendEmail --limit 50 --json
efc tasks retry <jobId…>       # re-queue specific jobs (one more attempt each)
efc tasks retry --all
efc tasks purge --all          # delete failed jobs
```

The backend is inferred — BullMQ when `REDIS_URL` is set, pg-boss for a `postgres` `DATABASE_URL` — or pass `--backend`, `--queue`, `--redis-url`, `--database-url`. See [CLI › diagnostics](../cli/diagnostics.md).

---

## Thread runner

`packages/core/src/tasks/thread-runner.ts` is a dual-purpose module:

- **Worker-thread side** — when loaded inside a `worker_threads` worker, reads `workerData.handlerPath` and `workerData.payload`, imports the task file, calls `def.handler(payload)`, and posts `{ ok: true }` or `{ ok: false, error }` back to the main thread.
- **Main-thread side** — exports `runInThread(handlerPath, payload)` which spawns a `new Worker(thread-runner.js, { workerData })` and returns a `Promise<void>` that resolves on `{ ok: true }` or rejects on error.

---

## Imports

```ts
// Task definition
import { defineTask } from 'express-file-cluster/tasks';

// Enqueue from anywhere (route handlers, other tasks, etc.)
import { enqueue } from 'express-file-cluster/tasks';
```

Both are exported from the `tasks` sub-path export of `express-file-cluster`.
