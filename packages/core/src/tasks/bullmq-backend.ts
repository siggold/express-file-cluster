import type { Job } from 'bullmq';
import type * as BullMQNS from 'bullmq';
import { taskRegistry, setEnqueueImpl } from './index.js';
import { runInThread } from './thread-runner.js';
import { getLogger } from '../logger.js';

interface BullMQOpts {
  redisUrl: string;
  concurrency: number;
  enqueueTimeout: number;
}

let closeImpl: (() => Promise<void>) | null = null;

/** Drains the BullMQ worker and closes both Redis connections. No-op if never initialised. */
export async function closeBullMQ(): Promise<void> {
  const close = closeImpl;
  closeImpl = null;
  await close?.();
}

export async function initBullMQ(opts: BullMQOpts): Promise<void> {
  let bullmq: typeof BullMQNS;
  try {
    bullmq = await import('bullmq');
  } catch {
    throw new Error('[EFC] bullmq is not installed. Run: npm install bullmq');
  }

  const connection = parseRedisUrl(opts.redisUrl);
  // With the offline queue on (ioredis default) queue.add() buffers forever while Redis is
  // down, so enqueue() never settles. Off, commands reject once the connection drops; the
  // initial connect is bounded by the enqueueTimeout race below.
  const queue = new bullmq.Queue('efc', {
    connection: { ...connection, enableOfflineQueue: false },
  });
  // Without a listener, ioredis connection errors surface as unhandled 'error' events.
  queue.on('error', () => {});

  const worker = new bullmq.Worker(
    'efc',
    async (job: Job) => {
      const def = taskRegistry.get(job.name);
      if (!def) {
        throw new Error(`[EFC] No task registered for name: ${job.name}`);
      }

      if (def.options.thread && def.filePath) {
        await runInThread(def.filePath, job.data);
      } else {
        await def.handler(job.data);
      }
    },
    { connection, concurrency: opts.concurrency },
  );

  worker.on('failed', (job: Job | undefined, err: Error) => {
    getLogger().error(
      { task: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err },
      `Task ${job?.name ?? 'unknown'} failed`,
    );
  });

  worker.on('error', (err: Error) => {
    getLogger().error(`Task worker error: ${err.message}`);
  });

  worker.on('completed', (job: Job) => {
    getLogger().info({ task: job.name, jobId: job.id }, `Task ${job.name} completed`);
  });

  setEnqueueImpl(async (name, payload) => {
    const def = taskRegistry.get(name);
    if (!def) {
      throw new Error(
        `[EFC] Cannot enqueue unknown task: "${name}". Is the task file in tasksDir?`,
      );
    }

    const add = queue.waitUntilReady().then(() =>
      queue.add(name, payload, {
        // BullMQ's `attempts` counts the first run; `retries` counts only the re-runs.
        attempts: (def.options.retries ?? 3) + 1,
        backoff: {
          type: def.options.backoff ?? 'exponential',
          delay: 1000,
        },
      }),
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `[EFC] Cannot enqueue task "${name}": Redis at ${connection.host}:${connection.port} did not respond within ${opts.enqueueTimeout}ms`,
            ),
          ),
        opts.enqueueTimeout,
      );
    });

    try {
      await Promise.race([add, timeout]);
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
    await worker.close();
    await queue.close();
  };

  getLogger().info('BullMQ backend initialised');
}

interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

export function parseRedisUrl(url: string): RedisConnection {
  try {
    const u = new URL(url);
    const result: RedisConnection = {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379', 10),
    };
    if (u.username) result.username = decodeURIComponent(u.username);
    if (u.password) result.password = decodeURIComponent(u.password);
    const db = parseInt(u.pathname.slice(1), 10);
    if (!Number.isNaN(db)) result.db = db;
    if (u.protocol === 'rediss:') result.tls = {};
    return result;
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}
