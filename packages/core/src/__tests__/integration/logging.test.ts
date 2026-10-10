import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters as strip } from 'node:util';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';

// Request IDs + structured logging through ignite(). Uses `pretty: true`, whose
// renderer writes via process.stdout.write and can therefore be captured in-process.
const LOGGER_MODULE = JSON.stringify(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../logger.ts'),
);

function writeRoute(dir: string, name: string, code: string) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((e) => (e ? reject(e) : resolve()));
  });
}


describe('integration — logging and request IDs', () => {
  let projectRoot: string;
  let apiDir: string;
  let server: Server | undefined;
  let output: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-logging-'));
    apiDir = path.join(projectRoot, 'src', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    process.chdir(projectRoot);
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += strip(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    writeRoute(
      apiDir,
      'hello.js',
      `import { getLogger } from ${LOGGER_MODULE};
export const GET = (req, res) => {
  getLogger().info({ marker: 'inside' }, 'handler ran');
  res.json({ id: req.id, same: req.log === getLogger() });
};`,
    );
    writeRoute(apiDir, 'boom.js', `export const GET = () => { throw new Error('kaboom'); };`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('generates a request ID, echoes it, and binds it to getLogger() inside the request', async () => {
    server = await ignite({ basePath: '/', cluster: false, port: 0, logging: { pretty: true } });
    const res = await request(server!).get('/hello');

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toEqual({ id: res.headers['x-request-id'], same: true });
    const short = String(res.headers['x-request-id']).slice(0, 8);
    expect(output).toMatch(new RegExp(`${short} handler ran marker=inside`));
    expect(output).toMatch(new RegExp(`${short} GET /hello 200 .*durationMs=`));
  });

  it('trusts a well-formed incoming X-Request-Id but replaces a malformed one', async () => {
    server = await ignite({ basePath: '/', cluster: false, port: 0, logging: { pretty: true } });

    const kept = await request(server!).get('/hello').set('X-Request-Id', 'lb-1234.abc');
    expect(kept.headers['x-request-id']).toBe('lb-1234.abc');

    const replaced = await request(server!)
      .get('/hello')
      .set('X-Request-Id', 'bad id "quoted" ' + 'x'.repeat(200));
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs unhandled errors with the request ID and stack, at error level', async () => {
    server = await ignite({ basePath: '/', cluster: false, port: 0, logging: { pretty: true } });
    const res = await request(server!).get('/boom');
    const short = String(res.headers['x-request-id']).slice(0, 8);

    expect(res.status).toBe(500);
    expect(output).toMatch(new RegExp(`ERROR .*${short} Unhandled error`));
    expect(output).toMatch(/Error: kaboom/);
    expect(output).toMatch(new RegExp(`ERROR .*${short} GET /boom 500`));
  });

  it('respects requests: false and logging: false', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      logging: { pretty: true, requests: false },
    });
    await request(server!).get('/hello');
    expect(output).toMatch(/handler ran/);
    expect(output).not.toMatch(/GET \/hello 200/);
    await closeServer(server!);

    output = '';
    server = await ignite({ basePath: '/', cluster: false, port: 0, logging: false });
    const res = await request(server!).get('/hello');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(output).toBe('');
  });
});
