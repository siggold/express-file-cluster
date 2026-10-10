import cluster, { type Worker } from 'node:cluster';
import { randomUUID } from 'node:crypto';
import type { Backend } from './index.js';
import { memoryBackend } from './index.js';
import { getLogger } from '../logger.js';

// The memory cache under clustering: the primary owns the only store and answers
// workers' requests over the cluster IPC channel, so every worker sees the same
// entries and the same revoked sessions. Message shape is tagged to avoid clashing
// with application IPC.

const TAG = '__efcCache';
const TIMEOUT_MS = 2000;

type Op = 'ping' | 'get' | 'set' | 'del' | 'clear';
interface Request {
  [TAG]: true;
  id: string;
  op: Op;
  args: unknown[];
}
interface Response {
  [TAG]: true;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const isTagged = (msg: unknown): msg is Record<string, unknown> =>
  msg !== null && typeof msg === 'object' && (msg as Record<string, unknown>)[TAG] === true;

/** Primary side: hold the store and serve every worker. Called before workers fork. */
export function servePrimaryCache(maxEntries: number): void {
  const store = memoryBackend(maxEntries);
  cluster.on('message', (worker: Worker, msg: unknown) => {
    if (!isTagged(msg)) return;
    const req = msg as unknown as Request;
    const run = async (): Promise<unknown> => {
      switch (req.op) {
        case 'ping':
          return 'pong';
        case 'get':
          return store.get(req.args[0] as string);
        case 'set':
          return store.set(
            req.args[0] as string,
            req.args[1] as string,
            req.args[2] as number | undefined,
          );
        case 'del':
          return store.del(req.args[0] as string[]);
        case 'clear':
          return store.clear(req.args[0] as string);
      }
    };
    run().then(
      (result) =>
        worker.isConnected() &&
        worker.send({ [TAG]: true, id: req.id, ok: true, result } satisfies Response),
      (err: unknown) =>
        worker.isConnected() &&
        worker.send({ [TAG]: true, id: req.id, ok: false, error: String(err) } satisfies Response),
    );
  });
}

/**
 * Worker side: a Backend that forwards to the primary. Resolves to null — so the caller
 * can fall back to a local store — when no EFC primary answers (e.g. the app runs its
 * own cluster primary instead of ignite()'s).
 */
export async function connectPrimaryCache(): Promise<Backend | null> {
  if (!process.send) return null;
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  const onMessage = (msg: unknown) => {
    if (!isTagged(msg)) return;
    const res = msg as unknown as Response;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  };
  process.on('message', onMessage);

  const call = (op: Op, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`[EFC] cache IPC "${op}" timed out`));
      }, TIMEOUT_MS);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      process.send!({ [TAG]: true, id, op, args } satisfies Request);
    });

  try {
    await call('ping');
  } catch {
    process.off('message', onMessage);
    getLogger().warn(
      'cache backend "memory": no EFC cluster primary answered — using a per-worker store (entries and revoked sessions are not shared)',
    );
    return null;
  }

  return {
    get: async (key) => (await call('get', key)) as string | null,
    set: async (key, value, ttl) => {
      await call('set', key, value, ttl);
    },
    del: async (keys) => (await call('del', keys)) as number,
    clear: async (prefix) => (await call('clear', prefix)) as number,
    close: async () => {
      process.off('message', onMessage);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
}
