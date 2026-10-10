import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ignite } from '../../index.js';

// Full auth lifecycle through ignite(): jwtSecret wires configureAuth during
// Pre-Flight, route files pull requireAuth/issueToken from the same module
// instance ignite() configured, and the cookie round-trips over real HTTP.
// Route files import the auth source by absolute path — a tmp project can't
// resolve the 'express-file-cluster/auth' package specifier.

const AUTH_MODULE = JSON.stringify(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../auth/index.ts'),
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

describe('integration — auth middleware via ignite()', () => {
  let projectRoot: string;
  let apiDir: string;
  let server: Server | undefined;
  const originalCwd = process.cwd();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-auth-'));
    apiDir = path.join(projectRoot, 'src', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    process.chdir(projectRoot);

    writeRoute(
      apiDir,
      'login.js',
      `import { issueToken } from ${AUTH_MODULE};
export const POST = async (req, res) => {
  await issueToken(res, { id: '1', role: req.body.role ?? 'user' });
  res.json({ ok: true });
};`,
    );
    writeRoute(
      apiDir,
      'logout.js',
      `import { revokeToken } from ${AUTH_MODULE};
export const POST = (_req, res) => { revokeToken(res); res.json({ ok: true }); };`,
    );
    writeRoute(
      apiDir,
      'me.js',
      `import { requireAuth, getCurrentUser } from ${AUTH_MODULE};
export const middlewares = [requireAuth];
export const GET = (_req, res) => res.json({ user: getCurrentUser() });`,
    );
    writeRoute(
      apiDir,
      'admin.js',
      `import { requireAuth } from ${AUTH_MODULE};
export const middlewares = [requireAuth('admin')];
export const GET = (_req, res) => res.json({ admin: true });`,
    );
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('issues an http-only cookie, verifies it, then revokes it', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      jwtSecret: 'integration-secret',
    });
    const agent = request.agent(server!);

    expect((await agent.get('/me')).status).toBe(401);

    const login = await agent.post('/login').send({});
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly/i);

    const me = await agent.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: '1', role: 'user' });

    await agent.post('/logout');
    expect((await agent.get('/me')).status).toBe(401);
  });

  it('enforces roles with requireAuth(role)', async () => {
    server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      jwtSecret: 'integration-secret',
    });

    const user = request.agent(server!);
    await user.post('/login').send({ role: 'user' });
    expect((await user.get('/admin')).status).toBe(403);

    const admin = request.agent(server!);
    await admin.post('/login').send({ role: 'admin' });
    expect((await admin.get('/admin')).status).toBe(200);
  });

  it('rejects a token signed with a different secret', async () => {
    server = await ignite({ basePath: '/', cluster: false, port: 0, jwtSecret: 'secret-a' });
    const cookie = String((await request(server!).post('/login').send({})).headers['set-cookie']);
    await closeServer(server!);

    server = await ignite({ basePath: '/', cluster: false, port: 0, jwtSecret: 'secret-b' });
    const res = await request(server!).get('/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});
