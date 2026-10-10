import type { Request, RequestHandler } from 'express';
import { cache } from './index.js';
import { getCurrentUser } from '../context.js';

export interface CacheResponseOptions {
  /** Seconds to keep a response. */
  ttl: number;
  /**
   * Cache per authenticated user (keyed by the JWT's `sub`/`id`). Put `requireAuth`
   * before this middleware. Without it, a response is shared by everyone hitting the URL.
   */
  perUser?: boolean;
  /** Custom cache key. Default: the request's original URL (path + query). */
  key?: (req: Request) => string;
}

interface Stored {
  status: number;
  body: unknown;
}

/** Key prefix for cached responses — `cache.clear(RESPONSE_PREFIX + '/v1/api/posts')` drops those. */
export const RESPONSE_PREFIX = 'res:';

/**
 * Caches successful (200) JSON responses of GET/HEAD requests. Adds `X-Cache: HIT|MISS`.
 *
 * @example
 * export const middlewares = [cacheResponse(60)];
 * export const middlewares = [requireAuth, cacheResponse({ ttl: 30, perUser: true })];
 */
export function cacheResponse(options: number | CacheResponseOptions): RequestHandler {
  const opts: CacheResponseOptions = typeof options === 'number' ? { ttl: options } : options;
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let scope = '';
    if (opts.perUser) {
      const user = getCurrentUser();
      const id = user?.['sub'] ?? user?.['id'];
      // Never fall back to a shared entry for a per-user route.
      if (id === undefined) return next();
      scope = `u:${String(id)}:`;
    }
    const key = RESPONSE_PREFIX + scope + (opts.key ? opts.key(req) : req.originalUrl);

    void (async () => {
      const hit = await cache.get<Stored>(key);
      if (hit) {
        res.setHeader('X-Cache', 'HIT');
        res.status(hit.status).json(hit.body);
        return;
      }
      res.setHeader('X-Cache', 'MISS');
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        if (res.statusCode === 200) void cache.set(key, { status: 200, body }, { ttl: opts.ttl });
        return json(body);
      };
      next();
    })().catch(next);
  };
}
