import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';
import { enqueue, taskRegistry } from '../../tasks/index.js';
import { closePgBoss, pgBossAdmin } from '../../tasks/pgboss-backend.js';

// pg-boss task backend against a real PostgreSQL. Skips when none is reachable.
const PG_URL = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test';

const TASKS_MODULE = JSON.stringify(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tasks/index.ts'),
);

async function reachable(): Promise<boolean> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const pgAvailable = await reachable();

type Events = { name: string; payload: unknown; attempt: number }[];
const events = (): Events => (globalThis as { __efcTaskEvents?: Events }).__efcTaskEvents!;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!pgAvailable)('integration — pg-boss task backend', () => {
  let projectRoot: string;
  let server: Server | undefined;
  let queue: string;
  const originalCwd = process.cwd();

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
      databaseUrl: PG_URL,
      tasks: { backend: 'pg-boss', queue },
    });
  }

  beforeEach(() => {
    (globalThis as { __efcTaskEvents?: Events }).__efcTaskEvents = [];
    taskRegistry.clear();
    queue = 'efctest' + Math.random().toString(36).slice(2, 8);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-pgboss-'));
    fs.mkdirSync(path.join(projectRoot, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'src', 'tasks'), { recursive: true });
    process.chdir(projectRoot);
  });

  afterEach(async () => {
    await closePgBoss();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('runs tasks, boxes non-object payloads, and retries until success', async () => {
    writeTask(
      'Record',
      `export default defineTask(async (payload) => { globalThis.__efcTaskEvents.push({ name: 'Record', payload, attempt: 1 }); });`,
    );
    writeTask(
      'Flaky',
      `let calls = 0;
export default defineTask({ retries: 2, backoff: 'fixed' }, async (payload) => {
  calls += 1;
  globalThis.__efcTaskEvents.push({ name: 'Flaky', payload, attempt: calls });
  if (calls === 1) throw new Error('first attempt fails');
});`,
    );
    await boot();

    await enqueue('Record', { to: 'a@example.com' });
    await enqueue('Record', 'just-a-string');
    await enqueue('Flaky', { n: 1 });
    await waitFor(() => events().length === 4);

    const records = events()
      .filter((e) => e.name === 'Record')
      .map((e) => e.payload);
    expect(records).toEqual(expect.arrayContaining([{ to: 'a@example.com' }, 'just-a-string']));
    expect(
      events()
        .filter((e) => e.name === 'Flaky')
        .map((e) => e.attempt),
    ).toEqual([1, 2]);
    await expect(enqueue('Nope', {})).rejects.toThrow(/unknown task/);
  }, 30_000);

  it('dead-letters after retries + 1 attempts; failed jobs can be listed, retried and purged', async () => {
    writeTask(
      'Doomed',
      `let calls = 0;
export default defineTask({ retries: 1, backoff: 'fixed' }, async (payload) => {
  calls += 1;
  globalThis.__efcTaskEvents.push({ name: 'Doomed', payload, attempt: calls });
  throw new Error('nope #' + calls);
});`,
    );
    await boot();
    await enqueue('Doomed', { order: 7 });

    const admin = await pgBossAdmin(PG_URL, queue);
    try {
      await waitFor(async () => (await admin.listFailed({ limit: 5 })).length === 1);
      expect(events().map((e) => e.attempt)).toEqual([1, 2]);
      const [job] = await admin.listFailed({ limit: 5 });
      expect(job).toMatchObject({
        name: 'Doomed',
        data: { order: 7 },
        error: 'nope #2',
        attempts: 2,
      });
      expect((await admin.counts())['failed']).toBe(1);

      expect(await admin.retry([job!.id])).toBe(1);
      await waitFor(() => events().length >= 3);
      await waitFor(async () => (await admin.listFailed({ limit: 5 }))[0]?.error === 'nope #3');

      expect(await admin.purge([])).toBe(1);
      expect(await admin.listFailed({ limit: 5 })).toEqual([]);
    } finally {
      await admin.close();
    }
  }, 60_000);

  it('registers cron schedules and removes stale ones', async () => {
    writeTask(
      'Nightly',
      `export default defineTask({ schedule: '0 3 * * *', timezone: 'UTC' }, async () => {});`,
    );
    await boot();
    const { PgBoss } = await import('pg-boss');
    const inspect = new PgBoss({ connectionString: PG_URL, supervise: false, schedule: false });
    inspect.on('error', () => {});
    await inspect.start();
    try {
      expect(
        (await inspect.getSchedules())
          .filter((s) => s.name.startsWith(queue + '.'))
          .map((s) => [s.name, s.cron]),
      ).toEqual([[`${queue}.Nightly`, '0 3 * * *']]);

      await closePgBoss();
      server!.closeAllConnections();
      await new Promise((r) => server!.close(r));
      server = undefined;
      taskRegistry.clear();
      fs.rmSync(path.join(projectRoot, 'src', 'tasks', 'Nightly.js'));
      writeTask('Daily', `export default defineTask(async () => {});`);
      await boot();
      expect((await inspect.getSchedules()).filter((s) => s.name.startsWith(queue + '.'))).toEqual(
        [],
      );
    } finally {
      await inspect.stop({ graceful: false });
    }
  }, 30_000);
});
