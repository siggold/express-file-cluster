import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';
import { cache, configureCache, closeCache } from '../../cache/index.js';
import { parseRedisUrl } from '../../tasks/bullmq-backend.js';
import type { CacheConfig } from '../../types.js';

// Cache API, cacheResponse and session revocation — each against both backends.
// The Redis runs use DB 15 and a unique key prefix; they skip when Redis is unreachable.
const REDIS_URL = process.env['EFC_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

function reachable(url: string): Promise<boolean> {
  const { host, port } = parseRedisUrl(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });
}

const redisAvailable = await reachable(REDIS_URL);
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = JSON.stringify(path.resolve(here, '../../index.ts'));
const AUTH = JSON.stringify(path.resolve(here, '../../auth/index.ts'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const backends: { name: string; config: () => CacheConfig; skip: boolean }[] = [
  { name: 'memory', config: () => ({ backend: 'memory', maxEntries: 3 }), skip: false },
  {
    name: 'redis',
    config: () => ({
      backend: 'redis',
      url: REDIS_URL,
      prefix: `efctest:${Math.random().toString(36).slice(2, 8)}:`,
    }),
    skip: !redisAvailable,
  },
];

afterAll(() => closeCache());

for (const b of backends) {
  describe.skipIf(b.skip)(`cache API — ${b.name}`, () => {
    beforeEach(async () => {
      await configureCache(b.config());
    });
    afterEach(async () => {
      await cache.clear();
      await closeCache();
    });

    it('stores JSON values, reports misses as undefined, and deletes', async () => {
      await cache.set('user:1', { name: 'Ada', tags: ['x'] });
      expect(await cache.get('user:1')).toEqual({ name: 'Ada', tags: ['x'] });
      expect(await cache.has('user:1')).toBe(true);
      expect(await cache.get('nope')).toBeUndefined();
      expect(await cache.del('user:1', 'nope')).toBe(1);
      expect(await cache.has('user:1')).toBe(false);
    });

    it('expires entries after their ttl', async () => {
      await cache.set('short', 1, { ttl: 1 });
      expect(await cache.get('short')).toBe(1);
      await sleep(1100);
      expect(await cache.get('short')).toBeUndefined();
    });

    it('wrap() computes once, caches, and shares one run between concurrent callers', async () => {
      let runs = 0;
      const compute = async () => {
        runs += 1;
        await sleep(30);
        return { n: 42 };
      };
      const [a, c] = await Promise.all([
        cache.wrap('w', 60, compute),
        cache.wrap('w', 60, compute),
      ]);
      expect(a).toEqual({ n: 42 });
      expect(c).toEqual({ n: 42 });
      expect(await cache.wrap('w', 60, compute)).toEqual({ n: 42 });
      expect(runs).toBe(1);
    });

    it('clear(prefix) removes only matching keys', async () => {
      await cache.set('res:/a', 1);
      await cache.set('res:/b', 2);
      await cache.set('other', 3);
      expect(await cache.clear('res:')).toBe(2);
      expect(await cache.get('other')).toBe(3);
    });

    it.skipIf(b.name !== 'memory')(
      'evicts least-recently-used entries beyond maxEntries',
      async () => {
        await cache.set('a', 1);
        await cache.set('b', 2);
        await cache.set('c', 3);
        await cache.get('a'); // a is now most recent
        await cache.set('d', 4);
        expect(await cache.get('b')).toBeUndefined();
        expect(await cache.get('a')).toBe(1);
      },
    );
  });
}

describe('cache API — redis unreachable', () => {
  afterEach(() => closeCache());

  it('degrades to misses and no-op writes instead of throwing or hanging', async () => {
    await configureCache({ backend: 'redis', url: 'redis://127.0.0.1:1', timeout: 200 });
    const start = Date.now();
    await expect(cache.set('k', 1)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.wrap('k', 10, async () => 'computed')).toBe('computed');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('throws a clear error when no cache is configured', async () => {
    await expect(cache.get('k')).rejects.toThrow(/Cache not configured/);
  });
});

function writeRoute(dir: string, name: string, code: string) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
}

for (const b of backends) {
  describe.skipIf(b.skip)(`through ignite() — ${b.name}`, () => {
    let projectRoot: string;
    let apiDir: string;
    let server: Server | undefined;
    const originalCwd = process.cwd();

    beforeEach(async () => {
      projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-cache-'));
      apiDir = path.join(projectRoot, 'src', 'api');
      fs.mkdirSync(apiDir, { recursive: true });
      process.chdir(projectRoot);

      writeRoute(
        apiDir,
        'counter.js',
        `import { cacheResponse } from ${INDEX};
let n = 0;
export const middlewares = [cacheResponse(60)];
export const GET = (req, res) => { n += 1; res.json({ n, q: req.query.q ?? null }); };
export const POST = (_req, res) => { n += 1; res.json({ n }); };`,
      );
      writeRoute(
        apiDir,
        'flaky.js',
        `import { cacheResponse } from ${INDEX};
let n = 0;
export const middlewares = [cacheResponse(60)];
export const GET = (_req, res) => { n += 1; res.status(n === 1 ? 503 : 200).json({ n }); };`,
      );
      writeRoute(
        apiDir,
        'login.js',
        `import { signToken } from ${AUTH};
export const POST = async (req, res) => res.json({ token: await signToken({ id: req.body.id, role: 'user' }) });`,
      );
      writeRoute(
        apiDir,
        'me.js',
        `import { requireAuth } from ${AUTH};
import { cacheResponse } from ${INDEX};
let n = 0;
export const middlewares = [requireAuth, cacheResponse({ ttl: 60, perUser: true })];
export const GET = (req, res) => { n += 1; res.json({ id: req.user.id, n }); };`,
      );
      writeRoute(
        apiDir,
        'logout.js',
        `import { requireAuth, revokeSession } from ${AUTH};
export const middlewares = [requireAuth];
export const POST = async (req, res) => { await revokeSession(req, res); res.json({ ok: true }); };`,
      );
      writeRoute(
        apiDir,
        'logout-all.js',
        `import { requireAuth, revokeAllSessions } from ${AUTH};
export const middlewares = [requireAuth];
export const POST = async (req, res) => { await revokeAllSessions(req.user.id); res.json({ ok: true }); };`,
      );

      server = await ignite({
        basePath: '/',
        cluster: false,
        port: 0,
        logging: false,
        jwtSecret: 'cache-test-secret',
        authStrategy: 'localStorage',
        cache: b.config(),
      });
    });

    afterEach(async () => {
      await cache.clear();
      await closeCache();
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server!.close(r));
        server = undefined;
      }
      process.chdir(originalCwd);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    const login = async (id: string) =>
      (await request(server!).post('/login').send({ id })).body.token as string;
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });

    it('cacheResponse serves repeat GETs from cache, per URL, and skips non-GET', async () => {
      const first = await request(server!).get('/counter');
      expect(first.headers['x-cache']).toBe('MISS');
      const again = await request(server!).get('/counter');
      expect(again.headers['x-cache']).toBe('HIT');
      expect(again.body).toEqual(first.body);

      expect((await request(server!).get('/counter?q=1')).headers['x-cache']).toBe('MISS');
      const post = await request(server!).post('/counter');
      expect(post.headers['x-cache']).toBeUndefined();
      expect(post.body.n).toBeGreaterThan(first.body.n);
    });

    it('does not cache non-200 responses', async () => {
      expect((await request(server!).get('/flaky')).status).toBe(503);
      const ok = await request(server!).get('/flaky');
      expect(ok.status).toBe(200);
      expect(ok.headers['x-cache']).toBe('MISS');
      expect((await request(server!).get('/flaky')).headers['x-cache']).toBe('HIT');
    });

    it('perUser keeps users’ cached responses apart', async () => {
      const ada = await login('ada');
      const bo = await login('bo');
      await request(server!).get('/me').set(as(ada));
      const adaHit = await request(server!).get('/me').set(as(ada));
      expect(adaHit.headers['x-cache']).toBe('HIT');
      expect(adaHit.body.id).toBe('ada');
      const boFirst = await request(server!).get('/me').set(as(bo));
      expect(boFirst.headers['x-cache']).toBe('MISS');
      expect(boFirst.body.id).toBe('bo');
    });

    it('revokeSession rejects that token only; revokeAllSessions rejects every earlier token', async () => {
      const phone = await login('ada');
      const laptop = await login('ada');
      expect((await request(server!).get('/me').set(as(phone))).status).toBe(200);

      expect((await request(server!).post('/logout').set(as(phone))).status).toBe(200);
      expect((await request(server!).get('/me').set(as(phone))).status).toBe(401);
      expect((await request(server!).get('/me').set(as(laptop))).status).toBe(200);

      const other = await login('bo');
      expect((await request(server!).post('/logout-all').set(as(laptop))).status).toBe(200);
      expect((await request(server!).get('/me').set(as(laptop))).status).toBe(401);
      expect((await request(server!).get('/me').set(as(other))).status).toBe(200);

      // A token issued right after the revocation — even in the same second — works.
      const fresh = await login('ada');
      expect((await request(server!).get('/me').set(as(fresh))).status).toBe(200);
    });
  });
}

describe('session revocation — cache unreachable', () => {
  it('fails open for requireAuth, but a revocation attempt reports failure', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-cache-down-'));
    const apiDir = path.join(projectRoot, 'src', 'api');
    writeRoute(
      apiDir,
      'login.js',
      `import { signToken } from ${AUTH};
export const POST = async (_req, res) => res.json({ token: await signToken({ id: 'ada' }) });`,
    );
    writeRoute(
      apiDir,
      'me.js',
      `import { requireAuth } from ${AUTH};
export const middlewares = [requireAuth];
export const GET = (req, res) => res.json({ id: req.user.id });`,
    );
    writeRoute(
      apiDir,
      'logout.js',
      `import { requireAuth, revokeSession } from ${AUTH};
export const middlewares = [requireAuth];
export const POST = async (req, res) => { await revokeSession(req, res); res.json({ ok: true }); };`,
    );
    const cwd = process.cwd();
    process.chdir(projectRoot);
    const server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      logging: false,
      jwtSecret: 'cache-test-secret',
      authStrategy: 'localStorage',
      cache: { backend: 'redis', url: 'redis://127.0.0.1:1', timeout: 200 },
    });
    try {
      const token = (await request(server!).post('/login')).body.token as string;
      const auth = { Authorization: `Bearer ${token}` };
      expect((await request(server!).get('/me').set(auth)).status).toBe(200);
      expect((await request(server!).post('/logout').set(auth)).status).toBe(500);
    } finally {
      await closeCache();
      server!.closeAllConnections();
      await new Promise((r) => server!.close(r));
      process.chdir(cwd);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
