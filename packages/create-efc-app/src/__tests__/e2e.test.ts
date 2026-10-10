import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { scaffold, NO_ADMIN_FEATURES, NO_USER_FEATURES } from '../scaffold.js';
import type { AdminFeatures, UserFeatures } from '../scaffold.js';

// Full scaffold flow, the way a user runs it: scaffold with the interactive defaults →
// npm install (against a packed tarball of the local core, not the registry) →
// `efc db migrate` → `efc start dev` → `efc build prod` → boot → real HTTP, for every stack. Slow and needs
// network plus MongoDB, Redis and PostgreSQL, so it only runs with EFC_E2E=1 (the `e2e`
// CI job sets it).
const RUN = process.env['EFC_E2E'] === '1';
const MONGO_URL = process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_e2e';
const PG_URL = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_e2e';

// Both supported stacks, each scaffolded with the interactive defaults otherwise.
// Each Postgres stack gets its own database (created fresh in beforeAll), so one stack's
// leftovers — e.g. a run kept with EFC_E2E_KEEP=1 — can't leak into another.
const pgDb = (name: string) => PG_URL.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
const STACKS = [
  {
    label: 'MongoDB + BullMQ',
    language: 'typescript',
    database: 'mongodb',
    taskBackend: 'bullmq',
    url: MONGO_URL,
  },
  {
    label: 'PostgreSQL + pg-boss',
    language: 'typescript',
    database: 'postgresql',
    taskBackend: 'pg-boss',
    url: pgDb('efc_e2e_ts'),
  },
  {
    label: 'JavaScript + PostgreSQL',
    language: 'javascript',
    database: 'postgresql',
    taskBackend: 'pg-boss',
    url: pgDb('efc_e2e_js'),
  },
] as const;

async function freshPostgresDb(url: string): Promise<void> {
  const { default: pg } = await import('pg');
  const name = new URL(url).pathname.slice(1);
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/?]*(\?|$)/, '/postgres$1') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../core');

const all = <T extends object>(flags: T): T =>
  Object.fromEntries(Object.keys(flags).map((k) => [k, true])) as T;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!RUN).each(STACKS)('create-efc-app — end to end ($label)', (stack) => {
  let workDir: string;
  let appDir: string;
  let server: ChildProcess | undefined;
  let out = '';

  beforeAll(async () => {
    if (stack.database === 'postgresql') await freshPostgresDb(stack.url);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'efc-e2e-'));
    appDir = path.join(workDir, 'my-api');

    const tarball = run('npm', ['pack', '--pack-destination', workDir], CORE_DIR)
      .trim()
      .split('\n')
      .pop()!;

    // Mirrors the defaults pre-selected in the interactive prompts (src/index.ts).
    await scaffold({
      projectName: appDir,
      language: stack.language,
      database: stack.database,
      authStrategy: 'http-only',
      cluster: true,
      tasks: true,
      taskBackend: stack.taskBackend,
      routeDocs: true,
      userPortal: true,
      adminPortal: true,
      userFeatures: all<UserFeatures>(NO_USER_FEATURES),
      adminFeatures: all<AdminFeatures>(NO_ADMIN_FEATURES),
      rbac: true,
      mailer: false,
    });

    const pkgPath = path.join(appDir, 'package.json');
    const pkg = await fs.readJson(pkgPath);
    pkg.dependencies['express-file-cluster'] = `file:${path.join(workDir, tarball)}`;
    await fs.writeJson(pkgPath, pkg, { spaces: 2 });

    const envPath = path.join(appDir, '.env');
    const env = (await fs.readFile(envPath, 'utf8')).replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=${stack.url}`,
    );
    await fs.writeFile(envPath, env);

    run('npm', ['install', '--no-audit', '--no-fund'], appDir);
  }, 300_000);

  it('creates the schema with efc db migrate', () => {
    const out = run(path.join(appDir, 'node_modules', '.bin', 'efc'), ['db', 'migrate'], appDir);
    expect(out).toMatch(/00000000000000_init[\s\S]*Ran 1 migration/);
  }, 120_000);

  afterAll(async () => {
    if (server?.pid && server.exitCode === null) process.kill(-server.pid, 'SIGKILL');
    // Leave the database clean for the next run: roll the init migration back.
    if (
      process.env['EFC_E2E_KEEP'] !== '1' &&
      appDir &&
      (await fs.pathExists(path.join(appDir, 'node_modules')))
    ) {
      try {
        run(path.join(appDir, 'node_modules', '.bin', 'efc'), ['db', 'rollback'], appDir);
      } catch {
        /* best effort */
      }
    }
    // EFC_E2E_KEEP=1 leaves the generated app on disk for debugging.
    if (workDir && process.env['EFC_E2E_KEEP'] !== '1') await fs.remove(workDir);
    else if (workDir) console.log(`kept: ${appDir}`);
  });

  it('serves the app with efc start dev', async () => {
    const port = await freePort();
    const dev = spawn(path.join(appDir, 'node_modules', '.bin', 'efc'), ['start', 'dev'], {
      cwd: appDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let devOut = '';
    dev.stdout!.on('data', (d: Buffer) => (devOut += d.toString()));
    dev.stderr!.on('data', (d: Buffer) => (devOut += d.toString()));
    try {
      const start = Date.now();
      for (;;) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/v1/api/health`);
          if (r.ok) break;
        } catch {
          /* not listening yet */
        }
        if (Date.now() - start > 30_000)
          throw new Error(`dev server never became healthy\n${devOut}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      if (dev.pid) process.kill(-dev.pid, 'SIGTERM');
      await new Promise((r) => dev.once('exit', r));
    }
  }, 60_000);

  it('builds for production with no type errors', () => {
    run(path.join(appDir, 'node_modules', '.bin', 'efc'), ['build', 'prod'], appDir);
    expect(fs.existsSync(path.join(appDir, 'dist', 'src', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'dist', 'src', 'api', 'health.js'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'dist', 'src', 'tasks', 'SendEmail.js'))).toBe(true);
    expect(
      fs.existsSync(path.join(appDir, 'dist', 'src', 'migrations', '00000000000000_init.js')),
    ).toBe(true);
    // The documented production path: migrations from compiled dist/ (no tsx in the image).
    const status = run(
      path.join(appDir, 'node_modules', '.bin', 'efc'),
      ['db', 'status', '--dist'],
      appDir,
    );
    expect(status).toMatch(/✓ 00000000000000_init batch 1/);
  }, 120_000);

  it('boots the built app and serves health, register, login and the authed /me route', async () => {
    const port = await freePort();
    // `efc start prod` never reads .env — inject it the way a hosting platform would.
    const dotenv = Object.fromEntries(
      (await fs.readFile(path.join(appDir, '.env'), 'utf8'))
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    server = spawn(path.join(appDir, 'node_modules', '.bin', 'efc'), ['start', 'prod'], {
      cwd: appDir,
      env: { ...process.env, ...dotenv, PORT: String(port), NODE_ENV: 'production' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    server.stderr!.on('data', (d: Buffer) => (out += d.toString()));

    const base = `http://127.0.0.1:${port}/v1/api`;
    const start = Date.now();
    for (;;) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() - start > 30_000) throw new Error(`server never became healthy\n${out}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toMatchObject({ status: 'OK' });

    const email = `e2e-${Date.now()}@example.com`;
    const register = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E', email, password: 'secret-pass-123' }),
    });
    expect(register.status, await register.clone().text()).toBe(201);

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret-pass-123' }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toBeTruthy();

    const me = await fetch(`${base}/auth/me`, { headers: { cookie: cookie! } });
    expect(me.status, await me.clone().text()).toBe(200);

    expect((await fetch(`${base}/auth/me`)).status).toBe(401);

    // Logout revokes the token itself: replaying the old cookie is rejected by every
    // worker (Redis cache on the BullMQ stack, the cluster-shared memory cache otherwise).
    const logout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie! },
    });
    expect(logout.status, await logout.clone().text()).toBe(200);
    for (let i = 0; i < 6; i++) {
      const replay = await fetch(`${base}/auth/me`, {
        headers: { cookie: cookie!, connection: 'close' },
      });
      expect(replay.status).toBe(401);
    }
  }, 60_000);

  it('shuts down cleanly on SIGTERM', async () => {
    const exited = new Promise<number | null>((resolve) => server!.once('exit', resolve));
    process.kill(server!.pid!, 'SIGTERM');
    expect(await exited, out).toBe(0);
  }, 30_000);
});
