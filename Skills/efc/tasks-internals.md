# EFC — Task System Internals (Exact)

Source: `packages/core/src/tasks/`

---

## Task naming rule

**The task name is the file's basename without extension.** This is the only rule. No path, no directory, no subdirectory.

```
tasksDir/SendEmail.ts         → name: "SendEmail"
tasksDir/ResizeImage.ts       → name: "ResizeImage"
tasksDir/jobs/DoWork.ts       → ERROR — scanTasks only reads top-level files
```

`scanTasks` uses `fs.readdirSync(tasksDir)` (non-recursive). **Sub-directories in `tasksDir` are not scanned.**

---

## `defineTask` — exact overloads

```ts
// Overload 1: handler only
defineTask<T>(handler: (payload: T) => Promise<void>): TaskDefinition<T>

// Overload 2: options + handler
defineTask<T>(options: TaskOptions, handler: (payload: T) => Promise<void>): TaskDefinition<T>
```

The returned `TaskDefinition` has `name: ''` — the name is set later by `registerTask()` when `scanTasks` processes the file.

**The `default` export must be a `TaskDefinition`**, not a plain function. `export default async (payload) => {}` will be rejected by `scanTasks` — it requires `def.handler` to be a function.

```ts
// ✅ correct
export default defineTask<Payload>(async (payload) => { ... });

// ❌ wrong — scanTasks will warn and skip this file
export default async function(payload: Payload) { ... }
```

---

## Task registration flow

```
scanTasks(tasksDir)
  → fs.readdirSync(tasksDir).filter(f => /\.(ts|js|mts|mjs)$/.test(f))
  → for each file:
      mod = await import(filePath)
      def = mod.default as TaskDefinition
      if (!def || typeof def.handler !== 'function') → warn + skip
      registerTask(basename_without_ext, { ...def, filePath })
```

`registerTask` stores to `taskRegistry: Map<string, TaskDefinition>`.

---

## `enqueue(name, payload)` — what it checks

```ts
async function enqueue<T>(name: string, payload: T): Promise<void> {
  if (!_impl) throw Error('[EFC] Task queue not initialised...')
  return _impl(name, payload)
}
```

`_impl` is set by `setEnqueueImpl()` called inside `initBullMQ()` or `initPgBoss()`. If `tasks` is not configured in `ignite()`, `_impl` is null and `enqueue()` always throws.

The BullMQ `_impl` also validates the name:
```ts
const def = taskRegistry.get(name)
if (!def) throw Error(`[EFC] Cannot enqueue unknown task: "${name}"...`)
```

So `enqueue` throws for both "no backend" and "unknown task name".

It also rejects when Redis is unreachable: the Queue's ioredis connection has `enableOfflineQueue: false`, and `waitUntilReady()` + `queue.add()` is raced against `tasks.enqueueTimeout` (default 5000 ms). Message: `[EFC] Cannot enqueue task "X": Redis at host:port did not respond within Nms`. A rejected job is never queued later.

---

## BullMQ queue name

The queue is named `'efc'` (hardcoded). All tasks share a single queue. The job `name` field is the task name (file basename).

---

## `thread: true` execution path

```
enqueue('ResizeImage', payload)
  → BullMQ picks up the job
  → processor: def = taskRegistry.get(job.name)
  → def.options.thread && def.filePath
        YES → runInThread(def.filePath, job.data)
        NO  → def.handler(job.data)
```

`runInThread` in `thread-runner.ts`:
- Spawns `new Worker(thread-runner.js, { workerData: { handlerPath, payload } })`
- Worker-side: imports `handlerPath`, reads `mod.default`, calls `def.handler(payload)`
- Resolves on `{ ok: true }`, rejects on `{ ok: false, error }`

`thread: true` requires `def.filePath` to be set. This is only guaranteed when the task was registered via `scanTasks` (which stores the file path). If you call `registerTask` manually without `filePath`, `thread: true` will silently fall through to the event loop (the `&&` short-circuits).

---

## Retry/backoff wiring (BullMQ)

```ts
queue.add(name, payload, {
  attempts: (def.options.retries ?? 3) + 1, // retries = re-runs; attempts counts the first run
  backoff: {
    type: def.options.backoff ?? 'exponential',
    delay: 1000,
  },
})
```

`backoff.delay: 1000` is hardcoded (1 second base delay). Exponential: 1s, 2s, 4s, ...

---

## Redis URL parsing

Built-in `parseRedisUrl` in `bullmq-backend.ts`:
```ts
// Parses: redis[s]://[user:password@]host[:port][/db]
{ host, port, username?, password?, db?, tls? }   // tls: {} for rediss://
```

Defaults: `host: 'localhost'`, `port: 6379`. User/password are URI-decoded.

---

## What `tasks` in `ignite()` does NOT do

- Does NOT start a dedicated task-runner process — tasks run inside each worker process.
- Does NOT auto-retry on `enqueue` failure — `enqueue` itself doesn't retry; the backend handles job-level retries.
- On `gracefulShutdown()`, the HTTP server closes first, then `closeBullMQ()` / `closePgBoss()` drain in-flight jobs before exit.
- Does NOT provide a dead-letter web UI — use `efc tasks failed | retry | purge` (or Bull Board).
- Does NOT support sub-directories in `tasksDir`.

---

## Cron schedules

`defineTask({ schedule: '<cron>', timezone?: '<IANA>' }, handler)`. Reconciled on every boot:

- **BullMQ**: `queue.upsertJobScheduler('efc-cron:<Task>', { pattern, tz }, { name, data: {}, opts })` — idempotent,
  so every cluster worker can run it. Schedulers with the `efc-cron:` prefix whose task lost its schedule are
  removed. Sync is not awaited (`whenSchedulesSynced()` exposes it for tests). 6-field patterns (seconds) work.
- **pg-boss**: `boss.schedule('<queue>.<Task>', cron, {}, { tz, retry… })`; stale `<queue>.*` schedules are
  `unschedule`d. One-minute resolution.
- Scheduled runs always receive `{}` as payload.

## pg-boss backend (`tasks/pgboss-backend.ts`)

- `new PgBoss({ connectionString: tasks.connectionString ?? databaseUrl, schema? })`, `start()`.
- One pg-boss queue per task, named `<tasks.queue>.<TaskName>` (default prefix `efc`); `createQueue` is idempotent.
- `retryLimit = retries` (pg-boss counts re-runs, like EFC), `retryDelay: 1`, `retryBackoff` for exponential.
- Non-object payloads are boxed as `{ __efcValue: payload }` and unboxed for the handler.
- `enqueue` = `boss.send(...)` raced against `enqueueTimeout`.

## Dead letters (`tasks/admin.ts`, CLI `efc tasks failed|retry|purge`)

`TaskAdmin` = `counts()`, `listFailed({ limit, name })`, `retry(ids)`, `purge(ids)` (empty ids = all).
BullMQ: `queue.getFailed`, `job.retry('failed')`, `job.remove()`. pg-boss: reads `pgboss.job WHERE state='failed'`,
then `boss.retry` / `boss.deleteJob`. A retried job gets exactly one more attempt on both backends.
CLI picks BullMQ when `REDIS_URL` is set, else pg-boss for a `postgres` `DATABASE_URL`; `--backend/--queue` override.
