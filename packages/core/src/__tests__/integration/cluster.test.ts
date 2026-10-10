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

async function boot(): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-cluster-'));
  roots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src', 'api'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'api', 'pid.js'),
    `export const GET = (_req, res) => res.json({ pid: process.pid });`,
  );
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
});
