import type { PgBoss as PgBossType } from 'pg-boss';
import type { TaskDefinition } from '../types.js';
import { taskRegistry, setEnqueueImpl } from './index.js';
import { runInThread } from './thread-runner.js';
import { getLogger } from '../logger.js';
import type { FailedJob, TaskAdmin } from './admin.js';

// pg-boss keeps one queue per job name, so each task gets its own pg-boss queue
// named `<tasks.queue>.<TaskName>` — the prefix keeps apps sharing a database apart.

interface PgBossOpts {
  connectionString: string;
  concurrency: number;
  enqueueTimeout: number;
  queue: string;
  schema?: string;
}

// pg-boss payloads must be objects; other values are boxed so any enqueue() payload works.
const BOX = '__efcValue';
const box = (payload: unknown): object =>
  payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as object)
    : { [BOX]: payload };
const unbox = (data: unknown): unknown =>
  data !== null && typeof data === 'object' && BOX in data
    ? (data as Record<string, unknown>)[BOX]
    : data;

const retryOptions = (def: TaskDefinition) => ({
  // pg-boss's retryLimit counts re-runs, exactly like EFC's `retries`.
  retryLimit: def.options.retries ?? 3,
  retryDelay: 1,
  retryBackoff: (def.options.backoff ?? 'exponential') === 'exponential',
});

async function loadPgBoss(): Promise<typeof PgBossType> {
  try {
    const mod = (await import('pg-boss')) as unknown as {
      PgBoss?: typeof PgBossType;
      default?: typeof PgBossType | { PgBoss: typeof PgBossType };
    };
    const ctor =
      mod.PgBoss ??
      (typeof mod.default === 'function'
        ? mod.default
        : (mod.default as { PgBoss: typeof PgBossType }).PgBoss);
    return ctor;
  } catch {
    throw new Error('[EFC] pg-boss is not installed. Run: npm install pg-boss');
  }
}

let closeImpl: (() => Promise<void>) | null = null;

export async function closePgBoss(): Promise<void> {
  const close = closeImpl;
  closeImpl = null;
  await close?.();
}

export async function initPgBoss(opts: PgBossOpts): Promise<void> {
  const PgBoss = await loadPgBoss();
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    ...(opts.schema !== undefined && { schema: opts.schema }),
  });
  boss.on('error', (err: Error) => getLogger().error({ err }, 'pg-boss error'));
  await boss.start();

  const queueFor = (name: string) => `${opts.queue}.${name}`;
  const wantedSchedules = new Set<string>();

  for (const def of taskRegistry.values()) {
    const queue = queueFor(def.name);
    await boss.createQueue(queue, retryOptions(def));
    await boss.work(
      queue,
      { localConcurrency: def.options.concurrency ?? opts.concurrency },
      async (jobs: { id: string; data: unknown; retryCount: number }[]) => {
        for (const job of jobs) {
          const payload = unbox(job.data);
          try {
            if (def.options.thread && def.filePath) await runInThread(def.filePath, payload);
            else await def.handler(payload);
            getLogger().info({ task: def.name, jobId: job.id }, `Task ${def.name} completed`);
          } catch (err) {
            getLogger().error(
              { task: def.name, jobId: job.id, attempt: job.retryCount + 1, err },
              `Task ${def.name} failed`,
            );
            throw err;
          }
        }
      },
    );
    if (def.options.schedule) {
      wantedSchedules.add(queue);
      await boss.schedule(
        queue,
        def.options.schedule,
        {},
        {
          ...retryOptions(def),
          ...(def.options.timezone !== undefined && { tz: def.options.timezone }),
        },
      );
    }
  }

  // Drop schedules for tasks that lost their `schedule` or no longer exist.
  for (const s of await boss.getSchedules()) {
    if (s.name.startsWith(`${opts.queue}.`) && !wantedSchedules.has(s.name)) {
      await boss.unschedule(s.name);
    }
  }
  if (wantedSchedules.size > 0) getLogger().info(`Scheduled ${wantedSchedules.size} cron task(s)`);

  setEnqueueImpl(async (name, payload) => {
    const def = taskRegistry.get(name);
    if (!def) {
      throw new Error(
        `[EFC] Cannot enqueue unknown task: "${name}". Is the task file in tasksDir?`,
      );
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `[EFC] Cannot enqueue task "${name}": PostgreSQL did not respond within ${opts.enqueueTimeout}ms`,
            ),
          ),
        opts.enqueueTimeout,
      );
    });
    try {
      await Promise.race([boss.send(queueFor(name), box(payload), retryOptions(def)), timeout]);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('[EFC]')) throw err;
      throw new Error(
        `[EFC] Cannot enqueue task "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  });

  closeImpl = async () => {
    // graceful: lets in-flight jobs finish before the connection pool closes.
    await boss.stop({ graceful: true, timeout: 10_000 });
  };

  getLogger().info('pg-boss backend initialised');
}

/** Dead-letter inspection for `efc tasks failed | retry | purge` on pg-boss. */
export async function pgBossAdmin(
  connectionString: string,
  queue = 'efc',
  schema = 'pgboss',
): Promise<TaskAdmin> {
  const PgBoss = await loadPgBoss();
  // No supervision or cron here: this instance only reads and settles jobs.
  const boss = new PgBoss({
    connectionString,
    schema,
    supervise: false,
    schedule: false,
    migrate: false,
  });
  boss.on('error', () => {});
  await boss.start();
  const db = boss.getDb();
  const prefix = `${queue}.`;
  const taskOf = (name: string) => name.slice(prefix.length);
  const table = `"${schema.replace(/"/g, '""')}".job`;

  const failedRows = async (ids: string[], limit = 10_000) =>
    (
      await db.executeSql(
        `SELECT id, name, data, output, retry_count, completed_on FROM ${table}
         WHERE state = 'failed' AND starts_with(name, $1) ${ids.length ? 'AND id = ANY($3::uuid[])' : ''}
         ORDER BY completed_on DESC NULLS LAST LIMIT $2`,
        ids.length ? [prefix, limit, ids] : [prefix, limit],
      )
    ).rows as {
      id: string;
      name: string;
      data: unknown;
      output: unknown;
      retry_count: number;
      completed_on: Date | null;
    }[];

  const byQueue = (rows: { id: string; name: string }[]) => {
    const groups = new Map<string, string[]>();
    for (const r of rows) groups.set(r.name, [...(groups.get(r.name) ?? []), r.id]);
    return groups;
  };

  return {
    async counts() {
      const { rows } = await db.executeSql(
        `SELECT state, count(*)::int AS n FROM ${table} WHERE starts_with(name, $1) GROUP BY state`,
        [prefix],
      );
      return Object.fromEntries(
        (rows as { state: string; n: number }[]).map((r) => [r.state, r.n]),
      );
    },
    async listFailed({ limit, name }) {
      const rows = (await failedRows([], name ? 10_000 : limit)).filter(
        (r) => !name || taskOf(r.name) === name,
      );
      return rows.slice(0, limit).map(
        (r): FailedJob => ({
          id: r.id,
          name: taskOf(r.name),
          data: unbox(r.data),
          error: String((r.output as { message?: string } | null)?.message ?? r.output ?? ''),
          attempts: r.retry_count + 1,
          failedAt: r.completed_on ?? undefined,
        }),
      );
    },
    async retry(ids) {
      const rows = await failedRows(ids);
      for (const [q, list] of byQueue(rows)) await boss.retry(q, list);
      return rows.length;
    },
    async purge(ids) {
      const rows = await failedRows(ids);
      for (const [q, list] of byQueue(rows)) await boss.deleteJob(q, list);
      return rows.length;
    },
    async close() {
      await boss.stop({ graceful: false });
    },
  };
}
