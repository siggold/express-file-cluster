import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import fs from 'fs-extra';
import { scaffold } from '../scaffold.js';
import { ITEMS, registryOptions, writeManifest } from '../registry.js';

// Full scaffold flow, the way a user runs it: scaffold with the interactive defaults →
// npm install (against a packed tarball of the local core, not the registry) →
// `efc start dev` (no migration first) → `efc db migrate` / `efc db sync` → `efc build prod` → boot →
// real HTTP, for every stack. Slow and needs
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

// What create-efc-app generates: the base plus registry items (src/index.ts).
async function createApp(
  stack: (typeof STACKS)[number],
  appDir: string,
  items: string[],
): Promise<void> {
  const variant = {
    language: stack.language,
    database: stack.database,
    modelApi: 'defineTable' as const,
  };
  const extra = { taskBackend: stack.taskBackend };
  await scaffold(registryOptions(variant, items, { ...extra, projectName: appDir }));
  await writeManifest(appDir, registryOptions(variant, items, extra), items);
}

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

// CI runners force colour output on; compare CLI text without ANSI escapes.
function run(cmd: string, args: string[], cwd: string): string {
  return stripVTControlCharacters(
    execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
}

describe.skipIf(!RUN).each(STACKS)('create-efc-app — end to end ($label)', (stack) => {
  let workDir: string;
  let appDir: string;
  let server: ChildProcess | undefined;
  let out = '';
  let serverUrl = '';

  beforeAll(async () => {
    if (stack.database === 'postgresql') await freshPostgresDb(stack.url);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'efc-e2e-'));
    appDir = path.join(workDir, 'my-api');

    const tarball = run('npm', ['pack', '--pack-destination', workDir], CORE_DIR)
      .trim()
      .split('\n')
      .pop()!;

    // Every feature but the email client (it would need real SMTP credentials).
    await createApp(
      stack,
      appDir,
      ITEMS.map((i) => i.name).filter((n) => n !== 'email-client'),
    );
    // A test-only route over the OAuth sign-in logic, so it runs against the real database.
    const ts = stack.language === 'typescript';
    await fs.outputFile(
      path.join(appDir, 'src', 'api', `oauth-test.${ts ? 'ts' : 'js'}`),
      `${ts ? "import type { Request, Response } from 'express';\n" : ''}import { signInWithOAuth } from '../lib/oauth.js';

export const POST = async (req${ts ? ': Request' : ''}, res${ts ? ': Response' : ''}) => {
  await signInWithOAuth(res, req.body);
  res.json({ ok: true });
};
`,
    );

    const pkgPath = path.join(appDir, 'package.json');
    const pkg = await fs.readJson(pkgPath);
    pkg.dependencies['express-file-cluster'] = `file:${path.join(workDir, tarball)}`;
    await fs.writeJson(pkgPath, pkg, { spaces: 2 });

    const envPath = path.join(appDir, '.env');
    // OAuth credentials: fake client IDs, but a real ES256 key, so the Apple client secret
    // is actually signed.
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const p8 = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).trim();
    const oauth: Record<string, string> = {
      GOOGLE_CLIENT_ID: 'efc-e2e.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'efc-e2e-secret',
      APPLE_CLIENT_ID: 'com.efc.e2e',
      APPLE_TEAM_ID: 'ABCDE12345',
      APPLE_KEY_ID: 'FGHIJ67890',
      APPLE_PRIVATE_KEY: p8.replace(/\n/g, '\\n'),
    };
    let env = (await fs.readFile(envPath, 'utf8')).replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=${stack.url}`,
    );
    for (const [k, v] of Object.entries(oauth)) {
      env = env.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    }
    await fs.writeFile(envPath, env);

    run('npm', ['install', '--no-audit', '--no-fund'], appDir);
  }, 300_000);

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
      // A write on a fresh database: only works if autoSync created the tables.
      const reg = await fetch(`http://127.0.0.1:${port}/v1/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Dev',
          email: `dev-${Date.now()}@example.com`,
          password: 'secret-pass-123',
        }),
      });
      expect(reg.status, `${await reg.clone().text()}\n${devOut}`).toBe(201);
    } finally {
      if (dev.pid) process.kill(-dev.pid, 'SIGTERM');
      await new Promise((r) => dev.once('exit', r));
    }
  }, 60_000);

  it('needs no migration first; efc db migrate and sync then find nothing to do', () => {
    // The dev-server step above ran on a fresh database: tables came from autoSync.
    const out = run(path.join(appDir, 'node_modules', '.bin', 'efc'), ['db', 'migrate'], appDir);
    expect(out).toMatch(/00000000000000_init[\s\S]*Ran 1 migration/);
    const sync = run(
      path.join(appDir, 'node_modules', '.bin', 'efc'),
      ['db', 'sync', '--dry-run'],
      appDir,
    );
    expect(sync).toMatch(/Everything in sync/);
  }, 120_000);

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
    serverUrl = base;
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

  it('signs in with Google and Apple', async () => {
    const base = serverUrl;
    const json = { 'content-type': 'application/json' };
    const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!;

    // Google: redirect with PKCE, then the callback trades the code at Google's token
    // endpoint — which rejects our fake code (502) — after checking the state.
    const g = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    expect(g.status).toBe(302);
    const gUrl = new URL(g.headers.get('location')!);
    expect(gUrl.origin).toBe('https://accounts.google.com');
    expect(gUrl.searchParams.get('client_id')).toBe('efc-e2e.apps.googleusercontent.com');
    expect(gUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const gCookie = cookieOf(g);
    const forged = await fetch(`${base}/auth/google/callback?code=fake&state=forged`, {
      headers: { cookie: gCookie },
      redirect: 'manual',
    });
    expect(forged.status, await forged.clone().text()).toBe(400);
    const gCallback = await fetch(
      `${base}/auth/google/callback?code=fake&state=${gUrl.searchParams.get('state')}`,
      { headers: { cookie: gCookie }, redirect: 'manual' },
    );
    expect(gCallback.status, `${await gCallback.clone().text()}\n${out}`).toBe(502);

    // Apple: form_post callback (cross-site cookie), client secret signed with the .p8 key.
    const a = await fetch(`${base}/auth/apple`, { redirect: 'manual' });
    expect(a.status).toBe(302);
    const aUrl = new URL(a.headers.get('location')!);
    expect(aUrl.origin).toBe('https://appleid.apple.com');
    expect(aUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(a.headers.get('set-cookie')).toMatch(/SameSite=None/i);
    const aCallback = await fetch(`${base}/auth/apple/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieOf(a) },
      body: new URLSearchParams({ code: 'fake', state: aUrl.searchParams.get('state')! }),
      redirect: 'manual',
    });
    expect(aCallback.status, `${await aCallback.clone().text()}\n${out}`).toBe(502);

    // Account linking, against the real database.
    const email = `oauth-${Date.now()}@example.com`;
    const signIn = (profile: Record<string, unknown>) =>
      fetch(`${base}/oauth-test`, { method: 'POST', headers: json, body: JSON.stringify(profile) });
    const me = async (r: Response) => {
      expect(r.status, `${await r.clone().text()}\n${out}`).toBe(200);
      const res = await fetch(`${base}/auth/me`, { headers: { cookie: cookieOf(r) } });
      return ((await res.json()) as { user: { id: string; email: string } }).user;
    };
    const created = await me(
      await signIn({
        provider: 'google',
        providerId: 'g-1',
        email,
        emailVerified: true,
        name: 'O',
      }),
    );
    expect(created.email).toBe(email);
    // Same verified email from another provider → the same user.
    const linked = await me(
      await signIn({ provider: 'apple', providerId: 'a-1', email, emailVerified: true }),
    );
    expect(linked.id).toBe(created.id);
    // A known identity needs no email.
    const again = await me(
      await signIn({ provider: 'google', providerId: 'g-1', emailVerified: false }),
    );
    expect(again.id).toBe(created.id);
    // An unknown identity without a verified email is refused.
    const unverified = await signIn({
      provider: 'google',
      providerId: 'g-2',
      email: `other-${Date.now()}@example.com`,
      emailVerified: false,
    });
    expect(unverified.status).toBe(400);
    // An email/password user can also sign in with a provider that verifies the same email.
    const pwEmail = `pw-${Date.now()}@example.com`;
    await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'PW', email: pwEmail, password: 'secret-pass-123' }),
    });
    const pwUser = await me(
      await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email: pwEmail, password: 'secret-pass-123' }),
      }),
    );
    const viaGoogle = await me(
      await signIn({ provider: 'google', providerId: 'g-3', email: pwEmail, emailVerified: true }),
    );
    expect(viaGoogle.id).toBe(pwUser.id);
  }, 60_000);

  it('shuts down cleanly on SIGTERM', async () => {
    const exited = new Promise<number | null>((resolve) => server!.once('exit', resolve));
    process.kill(server!.pid!, 'SIGTERM');
    expect(await exited, out).toBe(0);
  }, 30_000);
});

// The shadcn-style path: create the base app (server, src/api, src/tasks, database), then grow
// it with the real `efc add` binary from the packed framework.
describe.skipIf(!RUN).each([STACKS[1], STACKS[2]])('base app + efc add ($label)', (stack) => {
  let workDir: string;
  let appDir: string;
  let efc: string;
  let server: ChildProcess | undefined;
  let out = '';

  beforeAll(async () => {
    if (stack.database === 'postgresql') await freshPostgresDb(stack.url);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'efc-e2e-add-'));
    appDir = path.join(workDir, 'grown-api');
    const tarball = run('npm', ['pack', '--pack-destination', workDir], CORE_DIR)
      .trim()
      .split('\n')
      .pop()!;
    await createApp(stack, appDir, []);
    const pkgPath = path.join(appDir, 'package.json');
    const pkg = await fs.readJson(pkgPath);
    pkg.dependencies['express-file-cluster'] = `file:${path.join(workDir, tarball)}`;
    await fs.writeJson(pkgPath, pkg, { spaces: 2 });
    const envPath = path.join(appDir, '.env');
    await fs.writeFile(
      envPath,
      (await fs.readFile(envPath, 'utf8')).replace(
        /^DATABASE_URL=.*$/m,
        `DATABASE_URL=${stack.url}`,
      ),
    );
    run('npm', ['install', '--no-audit', '--no-fund'], appDir);
    efc = path.join(appDir, 'node_modules', '.bin', 'efc');
  }, 300_000);

  afterAll(async () => {
    if (server?.pid && server.exitCode === null) process.kill(-server.pid, 'SIGKILL');
    if (workDir && process.env['EFC_E2E_KEEP'] !== '1') await fs.remove(workDir);
    else if (workDir) console.log(`kept: ${appDir}`);
  });

  it('starts as just the base', () => {
    expect(fs.existsSync(path.join(appDir, 'src', 'api', 'auth'))).toBe(false);
    expect(fs.existsSync(path.join(appDir, 'src', 'model'))).toBe(false);
    expect(run(efc, ['list'], appDir)).toMatch(/admin-users/);
  });

  it('adds features with efc add, installing their packages', () => {
    const added = run(
      efc,
      ['add', 'billing', 'admin-users', 'forgot-password', 'email-client', 'auth@google', '--yes'],
      appDir,
    );
    expect(added).toMatch(
      /Adding auth, billing, admin, admin-users, forgot-password, email-client, auth@google/,
    );
    // No terminal → no questions; the credentials get placeholders.
    expect(added).toMatch(/GOOGLE_CLIENT_ID.*placeholder values/s);
    expect(added).toMatch(/update\s+src\/tasks\/SendEmail/);
    const pkg = fs.readJsonSync(path.join(appDir, 'package.json'));
    expect(pkg.dependencies).toMatchObject({
      bcrypt: expect.any(String),
      nodemailer: expect.any(String),
      jose: expect.any(String),
    });
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'jose'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'bcrypt'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'nodemailer'))).toBe(true);
    const manifest = fs.readJsonSync(path.join(appDir, 'efc.json'));
    expect(manifest.items).toEqual([
      'admin',
      'admin-users',
      'auth',
      'auth@google',
      'billing',
      'email-client',
      'forgot-password',
    ]);
    expect(run(efc, ['diff'], appDir)).toMatch(/Every installed feature matches the registry/);
    expect(run(efc, ['add', 'auth', '--yes'], appDir)).toMatch(/identical\s+src\/api\/auth\/login/);
  }, 300_000);

  it('builds for production with no type errors', () => {
    run(efc, ['build', 'prod'], appDir);
    expect(
      fs.existsSync(path.join(appDir, 'dist', 'src', 'api', 'admin', 'users', 'index.js')),
    ).toBe(true);
  }, 120_000);

  it('serves the added routes', async () => {
    const port = await freePort();
    const dotenv = Object.fromEntries(
      (await fs.readFile(path.join(appDir, '.env'), 'utf8'))
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    server = spawn(efc, ['start', 'prod'], {
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

    const email = `grown-${Date.now()}@example.com`;
    const register = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grown', email, password: 'secret-pass-123' }),
    });
    expect(register.status, `${await register.clone().text()}\n${out}`).toBe(201);
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret-pass-123' }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = login.headers.get('set-cookie')!;

    const plans = await fetch(`${base}/user/billing/plans`, { headers: { cookie } });
    expect(plans.status, `${await plans.clone().text()}\n${out}`).toBe(200);
    const forgot = await fetch(`${base}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(forgot.status, `${await forgot.clone().text()}\n${out}`).toBe(200);
    // Admin routes are behind requireAuth('admin').
    expect((await fetch(`${base}/admin/users`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${base}/admin/dashboard`)).status).toBe(401);

    const exited = new Promise<number | null>((resolve) => server!.once('exit', resolve));
    process.kill(server!.pid!, 'SIGTERM');
    expect(await exited, out).toBe(0);
  }, 90_000);
});
