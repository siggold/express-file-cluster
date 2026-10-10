import type * as BullMQNS from 'bullmq';
import { parseRedisUrl } from './bullmq-backend.js';

/** A job that exhausted its retries (BullMQ's failed set / pg-boss's failed state). */
export interface FailedJob {
  id: string;
  name: string;
  data: unknown;
  error: string;
  attempts: number;
  failedAt: Date | undefined;
}

/**
 * Dead-letter inspection used by `efc tasks failed | retry | purge`. Connects on its
 * own (outside ignite()), so it works against a running app's queue from any shell.
 */
export interface TaskAdmin {
  counts(): Promise<Record<string, number>>;
  listFailed(opts: { limit: number; name?: string }): Promise<FailedJob[]>;
  /** Re-queues failed jobs (all when `ids` is empty). Returns how many were retried. */
  retry(ids: string[]): Promise<number>;
  /** Deletes failed jobs (all when `ids` is empty). Returns how many were removed. */
  purge(ids: string[]): Promise<number>;
  close(): Promise<void>;
}

export async function bullmqAdmin(redisUrl: string, queueName = 'efc'): Promise<TaskAdmin> {
  let bullmq: typeof BullMQNS;
  try {
    bullmq = await import('bullmq');
  } catch {
    throw new Error('[EFC] bullmq is not installed. Run: npm install bullmq');
  }
  const queue = new bullmq.Queue(queueName, { connection: parseRedisUrl(redisUrl) });

  const failedJobs = async (ids: string[]): Promise<BullMQNS.Job[]> => {
    if (ids.length === 0) return queue.getFailed(0, -1);
    const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
    return jobs.filter((j): j is BullMQNS.Job => j != null && j.failedReason != null);
  };

  return {
    async counts() {
      return queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
    },
    async listFailed({ limit, name }) {
      const jobs = await queue.getFailed(0, name ? -1 : limit - 1);
      return jobs
        .filter((j) => !name || j.name === name)
        .slice(0, limit)
        .map((j) => ({
          id: String(j.id),
          name: j.name,
          data: j.data,
          error: j.failedReason,
          attempts: j.attemptsMade,
          failedAt: j.finishedOn ? new Date(j.finishedOn) : undefined,
        }));
    },
    async retry(ids) {
      const jobs = await failedJobs(ids);
      for (const job of jobs) await job.retry('failed');
      return jobs.length;
    },
    async purge(ids) {
      const jobs = await failedJobs(ids);
      for (const job of jobs) await job.remove();
      return jobs.length;
    },
    async close() {
      await queue.close();
    },
  };
}
