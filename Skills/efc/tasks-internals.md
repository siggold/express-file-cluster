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
- Does NOT auto-retry on `enqueue` failure — `enqueue` itself doesn't retry; BullMQ handles job-level retries.
- On `gracefulShutdown()`, the HTTP server closes first, then `closeBullMQ()` drains the worker (in-flight jobs finish) before exit.
- Does NOT provide a dead-letter UI — use a BullMQ dashboard (e.g. Bull Board) for that.
- Does NOT support sub-directories in `tasksDir`.
