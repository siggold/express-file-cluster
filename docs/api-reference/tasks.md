# Tasks — API Reference

Task functions are exported from the `tasks` sub-path:

```ts
import { defineTask, enqueue } from 'express-file-cluster/tasks';
```

---

## `defineTask(handler)` / `defineTask(options, handler)`

Creates a `TaskDefinition`. EFC scans top-level `.ts`, `.js`, `.mts`, and `.mjs` task files and registers those whose default export is a `TaskDefinition`. `efc tasks` lists matching filenames without importing them.

```ts
// Overloads
defineTask<T>(handler: (payload: T) => Promise<void>): TaskDefinition<T>
defineTask<T>(options: TaskOptions, handler: (payload: T) => Promise<void>): TaskDefinition<T>
```

### Minimal task

```ts
import { defineTask } from 'express-file-cluster/tasks';

export default defineTask<{ userId: string }>(async ({ userId }) => {
  await sendWelcomeEmail(userId);
});
```

### Task with options

```ts
import { defineTask } from 'express-file-cluster/tasks';

export default defineTask<{ key: string; width: number }>(
  {
    thread: true,       // run in worker_threads
    retries: 5,
    backoff: 'exponential',
    concurrency: 2,
  },
  async ({ key, width }) => {
    await resizeImage(key, width);
  },
);
```

---

## `TaskOptions`

```ts
interface TaskOptions {
  thread?: boolean;
  retries?: number;
  backoff?: 'fixed' | 'exponential';
  concurrency?: number;
  schedule?: string;
  timezone?: string;
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `thread` | `boolean` | `false` | Run handler in a `worker_threads` thread. Use for CPU-bound work. |
| `retries` | `number` | `3` | Re-runs after the first failed attempt, so a job runs at most `retries + 1` times before it is dead-lettered. |
| `backoff` | `'fixed' \| 'exponential'` | `'exponential'` | Retry delay strategy. Exponential starts at 1 second and doubles. |
| `concurrency` | `number` | `tasks.concurrency` from `ignite()` | Maximum parallel jobs of this type. |
| `schedule` | `string` | — | Cron pattern, e.g. `'*/15 * * * *'`. Scheduled runs receive `{}` as the payload. |
| `timezone` | `string` | server time | IANA timezone for `schedule`. |

---

## `enqueue(name, payload)`

Adds a job to the task queue.

```ts
async function enqueue<T>(name: string, payload: T): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Task name — the filename without extension (e.g. `'SendEmail'`) |
| `payload` | `T` | Data passed to the task handler |

```ts
import { enqueue } from 'express-file-cluster/tasks';

await enqueue('SendEmail', {
  to: 'alice@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up.',
});
```

`enqueue` rejects if:

- **Task backend not initialised** — `tasks` was not configured in `ignite()`.
- **Unknown task name** — no file with that basename exists in `src/tasks/`.
- **The queue backend is unreachable** — Redis (BullMQ) or PostgreSQL (pg-boss) didn't accept the job within `tasks.enqueueTimeout` (default 5000 ms). A readiness timeout prevents a later Redis submission. Commands already in flight may have committed despite a lost acknowledgment; do not automatically retry non-idempotent work. A pg-boss null acknowledgment rejects rather than reporting success.

```ts
try {
  await enqueue('SendEmail', payload);
} catch (err) {
  throw new HttpError(503, 'Queue unavailable, try again shortly');
}
```

---

## `TaskDefinition<T>`

The shape returned by `defineTask` and stored in the registry:

```ts
interface TaskDefinition<TPayload = unknown> {
  handler: (payload: TPayload) => Promise<void>;
  options: TaskOptions;
  name: string;        // set by scanTasks — empty string from defineTask itself
  filePath?: string;   // set by scanTasks — used by the thread runner
}
```

You do not construct `TaskDefinition` directly — always use `defineTask`.

---

## Task name resolution

The task name is the **file's basename without extension**:

```
src/tasks/SendEmail.ts    →  "SendEmail"
src/tasks/ResizeImage.ts  →  "ResizeImage"
```

The name is case-sensitive. `enqueue('sendEmail', ...)` will not match `SendEmail.ts`.

Since 0.12.0: opt-in OpenTelemetry instrumentation uses `tracing: true | TracingOptions`; the app owns its SDK and exporter. See [tracing](../guides/tracing.md) for HTTP/task propagation, trace log fields, thread behavior and shutdown ownership.

Since 0.12.0: pg-boss boxes reserved-key objects without changing the handler payload; old primitive wrappers remain readable. Thread execution rejects premature exits and disposes timers/open handles after completion, while awaiting pending bridge acknowledgments. Shutdown preserves shared cache until tasks settle and aggregates cleanup failures before exiting nonzero.
