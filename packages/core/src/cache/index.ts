import cluster from 'node:cluster';
import type { Redis as RedisClient, RedisOptions } from 'ioredis';
import type { CacheConfig } from '../types.js';
import { getLogger } from '../logger.js';
import { notInstalled } from '../db/postgres.js';
import { parseRedisUrl } from '../tasks/bullmq-backend.js';
import { connectPrimaryCache } from './ipc.js';

// A small key/value cache with two backends:
// - redis: shared by every worker and instance — what production wants.
// - memory: in-process; under clustering the primary holds it and workers reach it
//   over IPC, so it's shared by all workers on the machine (not across machines).
// Values are JSON-serialised. A Redis outage degrades to cache misses instead of
// failing the request — a cache must never be the thing that takes the API down.

export interface Backend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number | undefined): Promise<void>;
  del(keys: string[]): Promise<number>;
  clear(prefix: string): Promise<number>;
  close(): Promise<void>;
}

export function memoryBackend(maxEntries: number): Backend {
  const store = new Map<string, { value: string; expires: number }>();
  const live = (key: string) => {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (hit.expires !== 0 && hit.expires <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return hit;
  };
  return {
    async get(key) {
      const hit = live(key);
      if (!hit) return null;
      // Re-insert so Map order tracks recency (LRU eviction drops the oldest).
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    async set(key, value, ttl) {
      store.delete(key);
      store.set(key, { value, expires: ttl ? Date.now() + ttl * 1000 : 0 });
      while (store.size > maxEntries) store.delete(store.keys().next().value!);
    },
    async del(keys) {
      let n = 0;
      for (const k of keys) if (live(k) && store.delete(k)) n++;
      return n;
    },
    async clear(prefix) {
      let n = 0;
      for (const k of [...store.keys()]) if (k.startsWith(prefix) && store.delete(k)) n++;
      return n;
    },
    async close() {
      store.clear();
    },
  };
}

async function redisBackend(url: string, timeout: number): Promise<Backend> {
  let Redis: new (opts: RedisOptions) => RedisClient;
  try {
    const mod = (await import('ioredis')) as unknown as {
      Redis?: typeof Redis;
      default?: typeof Redis;
    };
    Redis = (mod.Redis ?? mod.default)!;
  } catch (err) {
    throw notInstalled(err, 'ioredis', 'npm install ioredis');
  }
  const client = new Redis({
    ...parseRedisUrl(url),
    // Fail fast instead of queueing commands while disconnected; callers treat
    // a rejected command as a miss.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: timeout,
  });
  let lastWarn = 0;
  client.on('error', (err: Error) => {
    // Reconnect attempts emit an error each time — log at most every 30 s.
    if (Date.now() - lastWarn > 30_000) {
      lastWarn = Date.now();
      getLogger().warn(`Cache Redis unavailable: ${err.message} (serving cache misses)`);
    }
  });

  // Wait for the first connection so writes made right after boot aren't dropped (the
  // offline queue is off), but never longer than a few timeouts: an unreachable Redis
  // must not block startup — the cache just serves misses until it comes back.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(2000, timeout * 2));
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return {
    get: (key) => client.get(key),
    async set(key, value, ttl) {
      if (ttl) await client.set(key, value, 'EX', Math.max(1, Math.ceil(ttl)));
      else await client.set(key, value);
    },
    del: (keys) => (keys.length ? client.del(...keys) : Promise.resolve(0)),
    async clear(prefix) {
      let n = 0;
      let cursor = '0';
      const match = prefix.replace(/[*?[\]\\]/g, '\\$&') + '*';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 500);
        cursor = next;
        if (keys.length) n += await client.unlink(...keys);
      } while (cursor !== '0');
      return n;
    },
    async close() {
      await client.quit().catch(() => client.disconnect());
    },
  };
}

let backend: Backend | null = null;
let prefix = 'efc:';
let revocationFailure: 'reject' | 'allow' = 'reject';

/** How requireAuth should treat a failed revocation check — see CacheConfig. */
export function revocationFailureMode(): 'reject' | 'allow' {
  return revocationFailure;
}
const pending = new Map<string, Promise<unknown>>();

export async function configureCache(config: CacheConfig): Promise<void> {
  await closeCache();
  prefix = config.prefix ?? 'efc:';
  revocationFailure = config.onRevocationCheckError ?? 'reject';
  if (config.backend === 'redis') {
    backend = await redisBackend(config.url ?? 'redis://localhost:6379', config.timeout ?? 1000);
  } else if (cluster.isWorker) {
    // Cluster workers share the primary's store over IPC (see cache/ipc.ts).
    backend = (await connectPrimaryCache()) ?? memoryBackend(config.maxEntries ?? 10_000);
  } else {
    backend = memoryBackend(config.maxEntries ?? 10_000);
  }
}

export function isCacheConfigured(): boolean {
  return backend !== null;
}

export async function closeCache(): Promise<void> {
  const b = backend;
  backend = null;
  pending.clear();
  await b?.close();
}

function requireBackend(): Backend {
  if (!backend) throw new Error('[EFC] Cache not configured — pass cache: { backend } to ignite()');
  return backend;
}

// Backend errors (Redis down/slow) degrade to "no cache" rather than failing the caller.
async function safely<T>(op: string, fn: (b: Backend) => Promise<T>, fallback: T): Promise<T> {
  const b = requireBackend();
  try {
    return await fn(b);
  } catch (err) {
    getLogger().debug({ err }, `cache ${op} failed`);
    return fallback;
  }
}

export interface CacheSetOptions {
  /** Seconds until the entry expires. Omit for no expiry. */
  ttl?: number;
}

export interface Cache {
  /** The cached value, or `undefined` on a miss (or when the backend is unreachable). */
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Deletes keys; returns how many existed. */
  del(...keys: string[]): Promise<number>;
  /**
   * Returns the cached value, or runs `fn`, caches its result and returns it.
   * Concurrent calls for the same key in one process share a single `fn` run.
   * `undefined` results are not cached.
   */
  wrap<T>(key: string, options: CacheSetOptions | number, fn: () => Promise<T>): Promise<T>;
  /** Deletes every key starting with `keyPrefix` (all of this app's keys when omitted). */
  clear(keyPrefix?: string): Promise<number>;
}

export const cache: Cache = {
  async get<T>(key: string) {
    const raw = await safely('get', (b) => b.get(prefix + key), null);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  },
  async set(key, value, options) {
    if (value === undefined) return;
    await safely('set', (b) => b.set(prefix + key, JSON.stringify(value), options?.ttl), undefined);
  },
  async has(key) {
    return (await safely('get', (b) => b.get(prefix + key), null)) !== null;
  },
  async del(...keys) {
    return safely('del', (b) => b.del(keys.map((k) => prefix + k)), 0);
  },
  async wrap<T>(key: string, options: CacheSetOptions | number, fn: () => Promise<T>) {
    const hit = await cache.get<T>(key);
    if (hit !== undefined) return hit;
    const inflight = pending.get(key) as Promise<T> | undefined;
    if (inflight) return inflight;
    const run = (async () => {
      try {
        const value = await fn();
        await cache.set(key, value, typeof options === 'number' ? { ttl: options } : options);
        return value;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, run);
    return run;
  },
  async clear(keyPrefix = '') {
    return safely('clear', (b) => b.clear(prefix + keyPrefix), 0);
  },
};

/** For auth's revocation checks, which must distinguish "absent" from "backend down". */
export async function rawGet(key: string): Promise<string | null> {
  return requireBackend().get(prefix + key);
}

export async function rawSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  await requireBackend().set(prefix + key, value, ttlSeconds);
}
