import type { IRouter, RequestHandler } from 'express';
import type { MountedRoute, RouteMeta, RouteEntry } from '../types.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function asyncWrap(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * For RegExp-mounted (catch-all) routes, Express exposes captures as params[0..n].
 * Rename them to the segment names from the file path; catch-alls become string
 * arrays (`[...slug]` → `['a', 'b']`), absent optional segments become undefined.
 */
function namedParams(route: RouteEntry): RequestHandler {
  const catchAlls = new Set([...route.urlPath.matchAll(/:([A-Za-z0-9_$]+)\*/g)].map((m) => m[1]!));
  return (req, _res, next) => {
    const positional = req.params as Record<string, string | undefined>;
    const named: Record<string, unknown> = {};
    route.params.forEach((name, i) => {
      const value = positional[String(i)];
      if (value === undefined || value === '') {
        named[name] = catchAlls.has(name) ? [] : undefined;
      } else if (catchAlls.has(name)) {
        named[name] = value.split('/').filter(Boolean).map(decodeURIComponent);
      } else {
        named[name] = decodeURIComponent(value);
      }
    });
    req.params = named as typeof req.params;
    next();
  };
}

export async function mountRoutes(app: IRouter, routes: RouteEntry[]): Promise<MountedRoute[]> {
  const mounted: MountedRoute[] = [];

  for (const route of routes) {
    const mod = (await import(route.filePath)) as Record<string, unknown>;
    const routeMiddlewares: RequestHandler[] = Array.isArray(mod['middlewares'])
      ? (mod['middlewares'] as RequestHandler[])
      : [];

    const raw = mod['meta'];
    const meta: RouteMeta | undefined =
      raw != null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as RouteMeta)
        : undefined;

    const routePath = route.pattern ?? route.urlPath;
    const paramMapper = route.pattern ? [namedParams(route)] : [];

    const implemented: HttpMethod[] = [];
    const unimplemented: HttpMethod[] = [];

    for (const method of HTTP_METHODS) {
      if (typeof mod[method] === 'function') {
        implemented.push(method);
        app[method.toLowerCase() as Lowercase<HttpMethod>](
          routePath,
          ...paramMapper,
          ...routeMiddlewares,
          asyncWrap(mod[method] as RequestHandler),
        );
      } else {
        unimplemented.push(method);
      }
    }

    if (implemented.length > 0 && unimplemented.length > 0) {
      const allowHeader = implemented.join(', ');
      app.all(routePath, (req, res, next) => {
        if ((unimplemented as string[]).includes(req.method)) {
          res.set('Allow', allowHeader).status(405).json({ error: 'Method Not Allowed' });
        } else {
          next();
        }
      });
    }

    mounted.push({ ...route, methods: implemented, ...(meta !== undefined && { meta }) });
  }

  return mounted;
}

export { asyncWrap };
