import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';

// End-to-end route resolution through ignite(): real files on disk → scanDir →
// mountRoutes → HTTP. Complements the unit-level scan/mount tests by exercising
// the ordering and middleware rules from CLAUDE.md against a live server.

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

describe('integration — route resolution', () => {
  let projectRoot: string;
  let apiDir: string;
  let server: Server | undefined;
  const originalCwd = process.cwd();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-routes-'));
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

  it('serves index files at their parent path', async () => {
    writeRoute(
      apiDir,
      'users/index.js',
      `export const GET = (_req, res) => res.json({ route: 'users' });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const res = await request(server!).get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ route: 'users' });
  });

  it('resolves nested dynamic segments', async () => {
    writeRoute(
      apiDir,
      'posts/[slug]/comments/[cid].js',
      `export const GET = (req, res) => res.json(req.params);`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const res = await request(server!).get('/posts/hello-world/comments/42');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: 'hello-world', cid: '42' });
  });

  it('matches a static sibling before a dynamic segment', async () => {
    writeRoute(
      apiDir,
      'users/[id].js',
      `export const GET = (req, res) => res.json({ dynamic: req.params.id });`,
    );
    writeRoute(
      apiDir,
      'users/me.js',
      `export const GET = (_req, res) => res.json({ static: 'me' });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const me = await request(server!).get('/users/me');
    expect(me.body).toEqual({ static: 'me' });

    const other = await request(server!).get('/users/7');
    expect(other.body).toEqual({ dynamic: '7' });
  });

  it('mounts routes under the default /v1/api basePath', async () => {
    writeRoute(apiDir, 'health.js', `export const GET = (_req, res) => res.json({ ok: true });`);
    server = await ignite({ cluster: false, port: 0 });

    expect((await request(server!).get('/v1/api/health')).status).toBe(200);
    expect((await request(server!).get('/health')).status).toBe(404);
  });

  it('applies file-level middlewares to every method in that file', async () => {
    writeRoute(
      apiDir,
      'tagged.js',
      `export const middlewares = [(req, _res, next) => { req.tag = 'mw'; next(); }];
export const GET = (req, res) => res.json({ tag: req.tag });
export const POST = (req, res) => res.json({ tag: req.tag });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).get('/tagged')).body).toEqual({ tag: 'mw' });
    expect((await request(server!).post('/tagged')).body).toEqual({ tag: 'mw' });
  });

  it('does not leak a file’s middlewares onto sibling routes', async () => {
    writeRoute(
      apiDir,
      'guarded.js',
      `export const middlewares = [(_req, res) => res.status(418).end()];
export const GET = (_req, res) => res.json({ reached: true });`,
    );
    writeRoute(apiDir, 'open.js', `export const GET = (_req, res) => res.json({ reached: true });`);
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).get('/guarded')).status).toBe(418);
    expect((await request(server!).get('/open')).body).toEqual({ reached: true });
  });

  it('returns 405 for unimplemented methods on a dynamic route', async () => {
    writeRoute(
      apiDir,
      'items/[id].js',
      `export const GET = (req, res) => res.json({ id: req.params.id });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).delete('/items/1')).status).toBe(405);
  });

  it('serves optional segments with and without the param', async () => {
    writeRoute(
      apiDir,
      'users/[[id]].js',
      `export const GET = (req, res) => res.json({ id: req.params.id ?? null });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).get('/users')).body).toEqual({ id: null });
    expect((await request(server!).get('/users/42')).body).toEqual({ id: '42' });
  });

  it('collects catch-all segments into an array, alongside named params', async () => {
    writeRoute(
      apiDir,
      'repos/[owner]/[...path].js',
      `export const GET = (req, res) => res.json(req.params);`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    const res = await request(server!).get('/repos/octo/src/lib/a%20b.ts');
    expect(res.body).toEqual({ owner: 'octo', path: ['src', 'lib', 'a b.ts'] });
    expect((await request(server!).get('/repos/octo')).status).toBe(404);
  });

  it('optional catch-all also matches the bare path, and specific routes still win', async () => {
    writeRoute(
      apiDir,
      'docs/[[...slug]].js',
      `export const GET = (req, res) => res.json({ slug: req.params.slug });`,
    );
    writeRoute(
      apiDir,
      'docs/intro.js',
      `export const GET = (_req, res) => res.json({ page: 'intro' });`,
    );
    writeRoute(
      apiDir,
      'docs/[id].js',
      `export const POST = (req, res) => res.json({ posted: req.params.id });`,
    );
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).get('/docs')).body).toEqual({ slug: [] });
    expect((await request(server!).get('/docs/a/b')).body).toEqual({ slug: ['a', 'b'] });
    expect((await request(server!).get('/docs/intro')).body).toEqual({ page: 'intro' });
  });

  it('returns 405 for unimplemented methods on a catch-all route', async () => {
    writeRoute(apiDir, 'files/[...path].js', `export const GET = (_req, res) => res.json({});`);
    server = await ignite({ basePath: '/', cluster: false, port: 0 });

    expect((await request(server!).delete('/files/a/b')).status).toBe(405);
  });
});
