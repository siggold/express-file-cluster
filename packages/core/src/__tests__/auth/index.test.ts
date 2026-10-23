import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import {
  configureAuth,
  issueToken,
  revokeToken,
  signToken,
  requireAuth,
} from '../../auth/index.js';

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/login', async (req, res) => {
    await issueToken(res, { id: '1', role: (req.query['role'] as string) ?? 'user' });
    res.json({ ok: true });
  });
  app.get('/logout', (_req, res) => {
    revokeToken(res);
    res.json({ ok: true });
  });
  app.get('/whoami', requireAuth, (req, res) => {
    res.json({ user: (req as typeof req & { user: unknown }).user });
  });
  app.get('/admin', requireAuth('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/staff', requireAuth('admin', 'moderator'), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireAuth', () => {
  beforeEach(() => {
    configureAuth({ secret: 'test-secret', strategy: 'http-only', expiresIn: '1h' });
  });

  it('rejects requests with no token', async () => {
    const res = await request(makeApp()).get('/whoami');
    expect(res.status).toBe(401);
  });

  it('accepts a valid token when used bare (no roles)', async () => {
    const agent = request.agent(makeApp());
    await agent.get('/login');
    const res = await agent.get('/whoami');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: '1', role: 'user' });
  });

  it('rejects a tampered/invalid token', async () => {
    const app = makeApp();
    const res = await request(app).get('/whoami').set('Cookie', 'efc_token=not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('allows access via requireAuth(role) when the role matches', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/login').query({ role: 'admin' });
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
  });

  it('returns 403 via requireAuth(role) when the role does not match', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/login').query({ role: 'user' });
    const res = await agent.get('/admin');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('accepts any role passed to requireAuth(...roles)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/login').query({ role: 'moderator' });
    const res = await agent.get('/staff');
    expect(res.status).toBe(200);
  });

  it('returns 401 (not 403) via requireAuth(role) when there is no token at all', async () => {
    const res = await request(makeApp()).get('/admin');
    expect(res.status).toBe(401);
  });

  it('revokeToken clears the cookie so a later request is unauthorized', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/login');
    await agent.get('/logout');
    const res = await agent.get('/whoami');
    expect(res.status).toBe(401);
  });

  it('supports the localStorage strategy via the Authorization header', async () => {
    configureAuth({ secret: 'test-secret', strategy: 'localStorage', expiresIn: '1h' });
    const token = await signToken({ id: '2', role: 'admin' });
    const res = await request(makeApp()).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
