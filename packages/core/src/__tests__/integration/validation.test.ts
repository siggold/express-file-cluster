import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';

// Route-level `export const schema` validation through ignite(). Route files import
// zod by absolute path — a tmp project has no node_modules of its own.
const ZOD = JSON.stringify(createRequire(import.meta.url).resolve('zod'));

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

describe('integration — request validation', () => {
  let projectRoot: string;
  let apiDir: string;
  let server: Server | undefined;
  const originalCwd = process.cwd();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-validate-'));
    apiDir = path.join(projectRoot, 'src', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    process.chdir(projectRoot);
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects an invalid body with 400 and every issue, and passes parsed data through', async () => {
    writeRoute(
      apiDir,
      'users.js',
      `import { z } from ${ZOD};
export const schema = {
  POST: { body: z.object({ email: z.string().email(), age: z.coerce.number().int().min(18), role: z.string().default('member') }) },
};
export const POST = (req, res) => res.status(201).json(req.body);
export const GET = (_req, res) => res.json({ unvalidated: true });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const bad = await request(server!).post('/users').send({ email: 'nope', age: 12 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Validation failed');
    expect(
      bad.body.issues
        .map((i: { location: string; path: string }) => `${i.location}.${i.path}`)
        .sort(),
    ).toEqual(['body.age', 'body.email']);

    const good = await request(server!).post('/users').send({ email: 'a@b.co', age: '21' });
    expect(good.status).toBe(201);
    expect(good.body).toEqual({ email: 'a@b.co', age: 21, role: 'member' });

    // GET has no schema entry → not validated.
    expect((await request(server!).get('/users')).status).toBe(200);
  });

  it('applies a file-wide schema to every method and validates query + params', async () => {
    writeRoute(
      apiDir,
      'items/[id].js',
      `import { z } from ${ZOD};
export const schema = {
  params: z.object({ id: z.coerce.number() }),
  query: z.object({ verbose: z.enum(['true', 'false']).optional() }),
};
export const GET = (req, res) => res.json({ id: req.params.id, query: req.query });
export const DELETE = (req, res) => res.json({ deleted: req.params.id });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const ok = await request(server!).get('/items/7?verbose=true');
    expect(ok.body).toEqual({ id: 7, query: { verbose: 'true' } });

    const badParam = await request(server!).delete('/items/abc');
    expect(badParam.status).toBe(400);
    expect(badParam.body.issues[0]).toMatchObject({ location: 'params', path: 'id' });

    const badQuery = await request(server!).get('/items/7?verbose=maybe');
    expect(badQuery.body.issues[0]).toMatchObject({ location: 'query', path: 'verbose' });
  });

  it('runs file middlewares (e.g. auth) before validation', async () => {
    writeRoute(
      apiDir,
      'guarded.js',
      `import { z } from ${ZOD};
export const middlewares = [(_req, res) => res.status(401).json({ error: 'Unauthorized' })];
export const schema = { body: z.object({ x: z.string() }) };
export const POST = (_req, res) => res.json({});`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).post('/guarded').send({})).status).toBe(401);
  });

  it('accepts any zod-style validator exposing safeParse', async () => {
    writeRoute(
      apiDir,
      'custom.js',
      `const evenOnly = {
  safeParse: (v) => v && typeof v.n === 'number' && v.n % 2 === 0
    ? { success: true, data: v }
    : { success: false, error: { issues: [{ message: 'n must be even', path: ['n'] }] } },
};
export const schema = { body: evenOnly };
export const POST = (req, res) => res.json(req.body);`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).post('/custom').send({ n: 2 })).status).toBe(200);
    const bad = await request(server!).post('/custom').send({ n: 3 });
    expect(bad.body.issues).toEqual([{ location: 'body', path: 'n', message: 'n must be even' }]);
  });
});
