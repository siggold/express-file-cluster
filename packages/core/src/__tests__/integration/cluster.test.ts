import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real multi-process cluster: a primary forks workers, a worker is SIGKILLed, and the
// primary must respawn it while the port keeps serving. Runs against the built dist/
// because cluster workers re-exec a plain `node` entrypoint (no vitest transform) —
// CI builds before testing; locally run `npm run build` first or this suite skips.
const DIST_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../dist/index.js',
);
const distBuilt = fs.existsSync(DIST_INDEX);

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

const workerPids = (out: string) => [...out.matchAll(/WORKER_PID (\d+)/g)].map((m) => Number(m[1]));

async function waitFor(predicate: () => boolean, label: string, output: () => string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 15_000) throw new Error(`timed out waiting for ${label}\n${output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const roots: string[] = [];

const AUTH_INDEX = path.resolve(path.dirname(DIST_INDEX), 'auth', 'index.js');

async function boot(
  extra: { config?: string; routes?: Record<string, string> } = {},
): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-cluster-'));
  roots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src', 'api'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'api', 'pid.js'),
    `export const GET = (_req, res) => res.json({ pid: process.pid });`,
  );
  for (const [file, code] of Object.entries(extra.routes ?? {})) {
    fs.writeFileSync(path.join(projectRoot, 'src', 'api', file), code);
  }
  const entry = path.join(projectRoot, 'server.mjs');
  fs.writeFileSync(
    entry,
    `import cluster from 'node:cluster';
import { ignite, gracefulShutdown } from ${JSON.stringify(DIST_INDEX)};
const server = await ignite({
  basePath: '/',
  cluster: true,
  workers: 2,
  port: Number(process.env.PORT),
  onWorkerCrash: (id, code) => console.log('CRASH', id, code),
  ${extra.config ?? ''}
});
gracefulShutdown(server);
if (cluster.isWorker) console.log('WORKER_PID', process.pid);`,
  );

  const port = await freePort();
  // detached → own process group, so a test can signal primary + workers together
  // the way Ctrl+C in a terminal does.
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  return { child, port, output: () => out };
}

describe.skipIf(!distBuilt)('integration — clustering', () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    if (child?.pid && child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
    child = undefined;
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('respawns a crashed worker and shuts down cleanly on a process-group SIGTERM', async () => {
    const { child: proc, port, output } = await boot();
    child = proc;

    await waitFor(() => workerPids(output()).length === 2, 'two workers', output);
    const [victim, survivor] = workerPids(output()) as [number, number];

    process.kill(victim, 'SIGKILL');
    await waitFor(() => /CRASH \d+ -1/.test(output()), 'crash hook', output);
    await waitFor(() => workerPids(output()).length === 3, 'respawned worker', output);

    const replacement = workerPids(output())[2]!;
    expect(new Set([victim, survivor, replacement]).size).toBe(3);

    const served = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/pid`, {
        headers: { connection: 'close' },
      });
      served.add(((await res.json()) as { pid: number }).pid);
    }
    expect(served.has(victim)).toBe(false);
    expect([...served].every((pid) => pid === survivor || pid === replacement)).toBe(true);

    const exited = new Promise<number | null>((resolve) => proc.once('exit', resolve));
    process.kill(-proc.pid!, 'SIGTERM');
    expect(await exited).toBe(0);
    expect(output()).toMatch(/All workers exited/);
  }, 30_000);

  it('stops workers when only the primary receives SIGTERM (docker stop / k8s)', async () => {
    const { child: proc, port, output } = await boot();
    child = proc;
    await waitFor(() => workerPids(output()).length === 2, 'two workers', output);

    const exited = new Promise<number | null>((resolve) => proc.once('exit', resolve));
    process.kill(proc.pid!, 'SIGTERM');
    expect(await exited).toBe(0);
    expect(output()).not.toMatch(/respawning/);
    await expect(fetch(`http://127.0.0.1:${port}/pid`)).rejects.toThrow();
  }, 30_000);

  it('shares the memory cache and revoked sessions across workers', async () => {
    const {
      child: proc,
      port,
      output,
    } = await boot({
      config: `jwtSecret: 'cluster-secret', authStrategy: 'localStorage', cache: { backend: 'memory' },`,
      routes: {
        'kv.js': `import { cache } from ${JSON.stringify(DIST_INDEX)};
export const POST = async (req, res) => { await cache.set('k', { by: process.pid, v: req.body.v }); res.json({ pid: process.pid }); };
export const GET = async (_req, res) => res.json({ pid: process.pid, value: (await cache.get('k')) ?? null });`,
        'login.js': `import { signToken } from ${JSON.stringify(AUTH_INDEX)};
export const POST = async (_req, res) => res.json({ token: await signToken({ id: 'ada' }) });`,
        'me.js': `import { requireAuth } from ${JSON.stringify(AUTH_INDEX)};
export const middlewares = [requireAuth];
export const GET = (_req, res) => res.json({ pid: process.pid });`,
        'logout.js': `import { requireAuth, revokeSession } from ${JSON.stringify(AUTH_INDEX)};
export const middlewares = [requireAuth];
export const POST = async (req, res) => { await revokeSession(req); res.json({ pid: process.pid }); };`,
      },
    });
    child = proc;
    await waitFor(() => workerPids(output()).length === 2, 'two workers', output);
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    const get = async (p: string, headers: Record<string, string> = {}) => {
      const r = await fetch(url(p), { headers: { connection: 'close', ...headers } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    const writer = (await (
      await fetch(url('/kv'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ v: 1 }),
      })
    ).json()) as { pid: number };

    // Read until both workers have answered: each must see the other's write.
    const readers = new Map<number, unknown>();
    for (let i = 0; i < 40 && readers.size < 2; i++) {
      const { body } = await get('/kv');
      readers.set(body['pid'] as number, body['value']);
    }
    expect(readers.size).toBe(2);
    for (const value of readers.values()) expect(value).toEqual({ by: writer.pid, v: 1 });

    const { token } = (await (
      await fetch(url('/login'), { method: 'POST', headers: { connection: 'close' } })
    ).json()) as {
      token: string;
    };
    const auth = { Authorization: `Bearer ${token}` };
    await fetch(url('/logout'), { method: 'POST', headers: { ...auth, connection: 'close' } });

    // Revoked on one worker → rejected by every worker.
    const seen = new Map<number, number>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const r = await fetch(url('/me'), { headers: { ...auth, connection: 'close' } });
      seen.set(i, r.status);
      if (r.status !== 401) break;
    }
    expect([...seen.values()].every((s) => s === 401)).toBe(true);
    expect(output()).not.toMatch(/no EFC cluster primary answered/);
  }, 30_000);
});
