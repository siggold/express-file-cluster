import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';
import { enqueue, taskRegistry } from '../../tasks/index.js';
import {
  closeBullMQ,
  parseRedisUrl,
  whenSchedulesSynced,
  SCHEDULER_PREFIX,
} from '../../tasks/bullmq-backend.js';
import { bullmqAdmin } from '../../tasks/admin.js';
import { execFileSync } from 'node:child_process';

// Task lifecycle against a real Redis: tasksDir scan → BullMQ worker → enqueue →
// process → retry. Uses DB 15 so it never touches a dev app's `efc` queue in DB 0.
// Skips itself, like model.integration.test.ts, when no Redis is reachable.
const REDIS_URL = process.env['EFC_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

const TASKS_MODULE = JSON.stringify(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tasks/index.ts'),
);

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

type Events = { name: string; payload: unknown; attempt: number }[];
const events = (): Events => (globalThis as { __efcTaskEvents?: Events }).__efcTaskEvents!;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((e) => (e ? reject(e) : resolve()));
  });
}

describe('integration — task queue', () => {
  let projectRoot: string;
  let server: Server | undefined;
  const originalCwd = process.cwd();

  beforeEach(() => {
    (globalThis as { __efcTaskEvents?: Events }).__efcTaskEvents = [];
    taskRegistry.clear();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-tasks-'));
    fs.mkdirSync(path.join(projectRoot, 'src', 'api'), { recursive: true });
    const tasksDir = path.join(projectRoot, 'src', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    process.chdir(projectRoot);

    // Unique per-run task names: a stale job left in Redis by an aborted run
    // can never be picked up as one of this run's jobs.
    const suffix = Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(
      path.join(tasksDir, `Record_${suffix}.js`),
      `import { defineTask } from ${TASKS_MODULE};
export default defineTask(async (payload) => {
  globalThis.__efcTaskEvents.push({ name: 'Record', payload, attempt: 1 });
});`,
    );
    fs.writeFileSync(
      path.join(tasksDir, `Flaky_${suffix}.js`),
      `import { defineTask } from ${TASKS_MODULE};
let calls = 0;
export default defineTask({ retries: 1, backoff: 'fixed' }, async (payload) => {
  calls += 1;
  globalThis.__efcTaskEvents.push({ name: 'Flaky', payload, attempt: calls });
  if (calls === 1) throw new Error('first attempt fails');
});`,
    );
    fs.writeFileSync(
      path.join(tasksDir, `AlwaysFails_${suffix}.js`),
      `import { defineTask } from ${TASKS_MODULE};
let calls = 0;
export default defineTask({ retries: 1, backoff: 'fixed' }, async (payload) => {
  calls += 1;
  globalThis.__efcTaskEvents.push({ name: 'AlwaysFails', payload, attempt: calls });
  throw new Error('always fails');
});`,
    );
  });

  afterEach(async () => {
    await closeBullMQ();
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const taskName = (prefix: string) => [...taskRegistry.keys()].find((k) => k.startsWith(prefix))!;

  it.skipIf(!redisAvailable)('runs an enqueued task off the request path', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      tasks: { backend: 'bullmq', redisUrl: REDIS_URL },
    });

    await enqueue(taskName('Record_'), { to: 'a@example.com' });
    await waitFor(() => events().length === 1);
    expect(events()[0]).toMatchObject({ name: 'Record', payload: { to: 'a@example.com' } });
  });

  it.skipIf(!redisAvailable)(
    'retries a failing task and succeeds on the next attempt',
    async () => {
      server = await ignite({
        basePath: '/',
        cluster: false,
        port: 0,
        tasks: { backend: 'bullmq', redisUrl: REDIS_URL },
      });

      await enqueue(taskName('Flaky_'), { n: 1 });
      await waitFor(() => events().length === 2);
      expect(events().map((e) => e.attempt)).toEqual([1, 2]);
    },
  );

  it.skipIf(!redisAvailable)(
    'stops after `retries` re-runs (retries + 1 attempts total)',
    async () => {
      server = await ignite({
        basePath: '/',
        cluster: false,
        port: 0,
        tasks: { backend: 'bullmq', redisUrl: REDIS_URL },
      });

      await enqueue(taskName('AlwaysFails_'), {});
      await waitFor(() => events().length === 2);
      // Long enough for a third attempt to show up if `retries: 1` were mis-mapped.
      await new Promise((r) => setTimeout(r, 2500));
      expect(events()).toHaveLength(2);
    },
  );

  it('rejects unknown task names immediately', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      tasks: { backend: 'bullmq', redisUrl: 'redis://127.0.0.1:1', enqueueTimeout: 200 },
    });

    await expect(enqueue('NoSuchTask', {})).rejects.toThrow(/unknown task/);
  });

  it('rejects within enqueueTimeout when Redis is unreachable instead of hanging', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      tasks: { backend: 'bullmq', redisUrl: 'redis://127.0.0.1:1', enqueueTimeout: 300 },
    });

    const start = Date.now();
    await expect(enqueue(taskName('Record_'), {})).rejects.toThrow(/did not respond within 300ms/);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe.skipIf(!redisAvailable)('integration — cron schedules and dead letters', () => {
  let projectRoot: string;
  let server: Server | undefined;
  let queue: string;
  const originalCwd = process.cwd();
  const DIST_CLI = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../dist/cli/index.js',
  );

  function writeTask(name: string, body: string) {
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'tasks', `${name}.js`),
      `import { defineTask } from ${TASKS_MODULE};\n${body}`,
    );
  }

  async function boot() {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      logging: false,
      tasks: { backend: 'bullmq', redisUrl: REDIS_URL, queue },
    });
    await whenSchedulesSynced();
  }

  beforeEach(() => {
    (globalThis as { __efcTaskEvents?: Events }).__efcTaskEvents = [];
    taskRegistry.clear();
    queue = 'efc-test-' + Math.random().toString(36).slice(2, 8);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-cron-'));
    fs.mkdirSync(path.join(projectRoot, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'src', 'tasks'), { recursive: true });
    process.chdir(projectRoot);
  });

  afterEach(async () => {
    await closeBullMQ();
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    const admin = await bullmqAdmin(REDIS_URL, queue);
    await admin.purge([]);
    await admin.close();
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('runs a task on its cron schedule', async () => {
    writeTask(
      'Tick',
      `export default defineTask({ schedule: '* * * * * *' }, async (payload) => {
  globalThis.__efcTaskEvents.push({ name: 'Tick', payload, attempt: 1 });
});`,
    );
    await boot();
    await waitFor(() => events().length >= 2, 5000);
    expect(events()[0]).toMatchObject({ name: 'Tick', payload: {} });
  });

  it('removes the scheduler once a task no longer has a schedule', async () => {
    writeTask('Tick', `export default defineTask({ schedule: '0 0 * * *' }, async () => {});`);
    await boot();
    const { Queue } = await import('bullmq');
    const q = new Queue(queue, { connection: parseRedisUrl(REDIS_URL) });
    expect((await q.getJobSchedulers(0, -1)).map((s) => s.key)).toEqual([
      SCHEDULER_PREFIX + 'Tick',
    ]);

    await closeBullMQ();
    await closeServer(server!);
    server = undefined;
    taskRegistry.clear();
    writeTask('Tick', `export default defineTask(async () => {});`);
    // Fresh import of the edited file: a new filename avoids the module cache.
    fs.renameSync(
      path.join(projectRoot, 'src', 'tasks', 'Tick.js'),
      path.join(projectRoot, 'src', 'tasks', 'Tock.js'),
    );
    await boot();
    expect(await q.getJobSchedulers(0, -1)).toEqual([]);
    await q.close();
  });

  it('lists, retries and purges dead-lettered jobs', async () => {
    writeTask(
      'Doomed',
      `let calls = 0;
export default defineTask({ retries: 0 }, async (payload) => {
  calls += 1;
  globalThis.__efcTaskEvents.push({ name: 'Doomed', payload, attempt: calls });
  throw new Error('nope #' + calls);
});`,
    );
    await boot();
    await enqueue('Doomed', { order: 1 });
    await waitFor(() => events().length === 1);

    const admin = await bullmqAdmin(REDIS_URL, queue);
    try {
      let failed = await admin.listFailed({ limit: 10 });
      for (let i = 0; failed.length === 0 && i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        failed = await admin.listFailed({ limit: 10 });
      }
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        name: 'Doomed',
        data: { order: 1 },
        error: 'nope #1',
        attempts: 1,
      });

      expect(await admin.retry([failed[0]!.id])).toBe(1);
      await waitFor(() => events().length === 2);
      for (
        let i = 0;
        (await admin.listFailed({ limit: 10 }))[0]?.error !== 'nope #2' && i < 40;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await admin.listFailed({ limit: 10 }))[0]?.error).toBe('nope #2');

      expect(await admin.purge([])).toBe(1);
      expect(await admin.listFailed({ limit: 10 })).toEqual([]);
    } finally {
      await admin.close();
    }
  });

  it.skipIf(!fs.existsSync(DIST_CLI))(
    '`efc tasks failed --json` reads the dead-letter queue',
    async () => {
      writeTask(
        'Doomed',
        `export default defineTask({ retries: 0 }, async () => { throw new Error('cli-visible'); });`,
      );
      await boot();
      await enqueue('Doomed', { via: 'cli' });
      const admin = await bullmqAdmin(REDIS_URL, queue);
      for (let i = 0; (await admin.listFailed({ limit: 1 })).length === 0 && i < 60; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await admin.close();

      const out = execFileSync(
        process.execPath,
        [DIST_CLI, 'tasks', 'failed', '--json', '--redis-url', REDIS_URL, '--queue', queue],
        { encoding: 'utf8' },
      );
      expect(JSON.parse(out)).toMatchObject([
        { name: 'Doomed', data: { via: 'cli' }, error: 'cli-visible' },
      ]);
    },
  );
});

describe('parseRedisUrl', () => {
  it('parses host, port, credentials, db and TLS', () => {
    expect(parseRedisUrl('rediss://default:p%40ss@cache.example.com:6380/2')).toEqual({
      host: 'cache.example.com',
      port: 6380,
      username: 'default',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
  });

  it('defaults to localhost:6379 with no db or TLS', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
  });
});
