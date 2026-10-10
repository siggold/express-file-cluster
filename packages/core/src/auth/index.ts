import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AuthStrategy } from '../types.js';
import { setCurrentUser } from '../context.js';
import { isCacheConfigured, rawGet, rawSet, revocationFailureMode } from '../cache/index.js';
import { getLogger } from '../logger.js';

interface AuthConfig {
  secret: string;
  strategy: AuthStrategy;
  expiresIn: string;
  cookieDomain?: string | undefined;
}

let _config: AuthConfig | null = null;

export function configureAuth(config: AuthConfig): void {
  _config = config;
}

function getConfig(): AuthConfig {
  if (!_config) throw new Error('[EFC] Auth not configured — pass jwtSecret to ignite()');
  return _config;
}

// Every token carries a unique `jti` (so one session can be revoked) and its issue
// time in milliseconds, `efc_iat` (so "revoke all sessions issued before now" doesn't
// also catch a token minted in the same second as the revocation).
async function sign(payload: Record<string, unknown>): Promise<string> {
  const { secret, expiresIn } = getConfig();
  return new SignJWT({ ...payload, efc_iat: Date.now() })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

export async function issueToken(res: Response, payload: Record<string, unknown>): Promise<void> {
  const { cookieDomain } = getConfig();
  const token = await sign(payload);

  res.cookie('efc_token', token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    ...(cookieDomain !== undefined && { domain: cookieDomain }),
  });
}

export function revokeToken(res: Response): void {
  res.clearCookie('efc_token');
}

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  return sign(payload);
}

function tokenFrom(req: Request): string | undefined {
  if (getConfig().strategy === 'http-only') {
    return (req as typeof req & { cookies?: Record<string, string> }).cookies?.['efc_token'];
  }
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(getConfig().secret));
  return payload;
}

const userIdOf = (payload: JWTPayload): string | undefined => {
  const id = payload.sub ?? (payload as Record<string, unknown>)['id'];
  return id === undefined || id === null ? undefined : String(id);
};

// ── Session revocation (needs `cache` in ignite()) ───────────────────────────
// Stateless JWTs can't be "un-issued", so revocation is a denylist in the cache:
// one key per revoked token (`sess:jti:<jti>`, kept until that token would expire)
// and one per user for "everything issued before T" (`sess:user:<id>`).

/** Lifetime of a token signed now, in seconds — `jwtExpiresIn` like '15m', '7d'. */
function tokenLifetimeSeconds(): number {
  const m =
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i.exec(
      getConfig().expiresIn.trim(),
    );
  if (!m) return 30 * 86_400;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's')[0]!.toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800, y: 31_557_600 }[unit] ?? 1;
  return Math.ceil(n * factor);
}

let lastRevocationError = 0;

async function isRevoked(payload: JWTPayload): Promise<boolean> {
  if (payload.jti && (await rawGet(`sess:jti:${payload.jti}`)) !== null) return true;
  const userId = userIdOf(payload);
  if (userId === undefined) return false;
  const cutoff = await rawGet(`sess:user:${userId}`);
  if (cutoff === null) return false;
  const issuedMs =
    typeof (payload as Record<string, unknown>)['efc_iat'] === 'number'
      ? ((payload as Record<string, unknown>)['efc_iat'] as number)
      : (payload.iat ?? 0) * 1000; // tokens minted before efc_iat existed
  return issuedMs < Number(cutoff);
}

function requireRevocationStore(): void {
  if (!isCacheConfigured()) {
    throw new Error(
      '[EFC] Session revocation needs a cache — pass cache: { backend: "redis" } to ignite()',
    );
  }
}

/**
 * Revokes the token the current request was authenticated with: `requireAuth` rejects
 * it from now until it would have expired anyway. Pass `res` to also clear the cookie
 * (http-only strategy). Throws if the cache is unreachable, so a failed logout is visible.
 */
export async function revokeSession(req: Request, res?: Response): Promise<void> {
  requireRevocationStore();
  const token = tokenFrom(req);
  if (res && getConfig().strategy === 'http-only') res.clearCookie('efc_token');
  if (!token) return;
  let payload: JWTPayload;
  try {
    payload = await verify(token);
  } catch {
    return; // already invalid or expired — nothing to revoke
  }
  if (!payload.jti) return;
  const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : tokenLifetimeSeconds();
  if (ttl > 0) await rawSet(`sess:jti:${payload.jti}`, '1', ttl);
}

/**
 * Revokes every token issued to `userId` (the JWT's `sub` or `id` claim) before now —
 * "log out of all devices", or after a password change. Tokens issued afterwards work.
 */
export async function revokeAllSessions(userId: string | number): Promise<void> {
  requireRevocationStore();
  await rawSet(`sess:user:${String(userId)}`, String(Date.now()), tokenLifetimeSeconds());
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
  roles: string[],
): Promise<void> {
  try {
    const token = tokenFrom(req);

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = await verify(token);

    if (isCacheConfigured()) {
      let revoked = false;
      try {
        revoked = await isRevoked(payload);
      } catch (err) {
        const reject = revocationFailureMode() === 'reject';
        if (Date.now() - lastRevocationError > 30_000) {
          lastRevocationError = Date.now();
          getLogger().error(
            { err },
            `Session revocation check failed — ${reject ? 'rejecting with 503' : 'allowing'} authenticated requests`,
          );
        }
        // 503, not 401: the session isn't invalid, the check is unavailable — clients
        // shouldn't discard the token and force a re-login over a cache blip.
        if (reject) {
          res.status(503).json({ error: 'Service Unavailable', statusCode: 503 });
          return;
        }
      }
      if (revoked) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    if (roles.length > 0) {
      const role = (payload as Record<string, unknown>)['role'];
      if (typeof role !== 'string' || !roles.includes(role)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    (req as typeof req & { user: unknown }).user = payload;
    setCurrentUser(payload as Record<string, unknown>);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Used bare (`middlewares = [requireAuth]`) it just verifies the JWT.
 * Called with role names (`middlewares = [requireAuth('admin')]`) it
 * returns a middleware that also enforces `payload.role` is one of them.
 */
export interface RequireAuth {
  (req: Request, res: Response, next: NextFunction): void;
  (...roles: string[]): RequestHandler;
}

export const requireAuth: RequireAuth = ((...args: unknown[]) => {
  if (args.length > 0 && typeof args[0] === 'string') {
    const roles = args as string[];
    return (req: Request, res: Response, next: NextFunction) => {
      void authenticate(req, res, next, roles);
    };
  }
  const [req, res, next] = args as [Request, Response, NextFunction];
  void authenticate(req, res, next, []);
}) as RequireAuth;

// Reads the JWT payload requireAuth attached for the in-flight request, from
// anywhere — not just where `req` is in scope. Returns undefined outside a
// request, or on a request that never ran through requireAuth.
export { getCurrentUser } from '../context.js';
