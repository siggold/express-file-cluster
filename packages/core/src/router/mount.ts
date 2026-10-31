import { asyncWrap } from '../middleware.js';
import type { IRouter, RequestHandler } from 'express';
import type { MountedRoute, RouteMeta, RouteEntry, RouteSchema } from '../types.js';
import { schemaFor, validateRequest } from './validate.js';
import { isUpgrade, websocketOnly, websocketHandler, type WebSocketHandler } from '../websocket.js';

import { traceRoute } from '../tracing.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * For RegExp-mounted (catch-all) routes, Express exposes captures as params[0..n].
 * Rename them to the segment names from the file path; catch-alls become string
 * arrays (`[...slug]` → `['a', 'b']`), absent optional segments become undefined.
 */
function namedParams(route: RouteEntry): RequestHandler {
  const catchAlls = new Set([...route.urlPath.matchAll(/:([A-Za-z0-9_$]+)\*/g)].map((m) => m[1]!));
  return (req, _res, next) => {
    // Express has already decoded req.params. Read the raw captures so splitting
    // happens before decoding (an encoded slash belongs to a single segment).
    const captures = route.pattern!.exec(req.path);
    const named: Record<string, unknown> = {};
    route.params.forEach((name, i) => {
      const value = captures?.[i + 1];
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

    const schema =
      mod['schema'] != null && typeof mod['schema'] === 'object'
        ? (mod['schema'] as RouteSchema)
        : undefined;

    const routePath = route.pattern ?? route.urlPath;
    const paramMapper = route.pattern ? [namedParams(route)] : [];

    const websocket = typeof mod['WS'] === 'function';
    if (mod['WS'] !== undefined && !websocket)
      throw new Error(`[EFC] WS must be a function: ${route.filePath}`);
    if (websocket) {
      const validation = schemaFor(schema, 'WS');
      app.all(
        routePath,
        websocketOnly,
        traceRoute(route.urlPath),
        ...paramMapper,
        ...routeMiddlewares.map(asyncWrap),
        ...(validation ? [validateRequest(validation)] : []),
        websocketHandler(mod['WS'] as WebSocketHandler),
      );
    }
    const httpOnly: RequestHandler = (req, _res, next) => (isUpgrade(req) ? next('route') : next());
    const implemented = HTTP_METHODS.filter((method) => typeof mod[method] === 'function');
    // Express GET also matches HEAD, so explicit HEAD must be registered first.
    const order = ['HEAD', ...HTTP_METHODS.filter((method) => method !== 'HEAD')] as HttpMethod[];
    for (const method of order) {
      if (!implemented.includes(method)) continue;
      const methodSchema = schemaFor(schema, method);
      const validation = methodSchema ? [validateRequest(methodSchema)] : [];
      app[method.toLowerCase() as Lowercase<HttpMethod>](
        routePath,
        httpOnly,
        traceRoute(route.urlPath),
        ...paramMapper,
        ...routeMiddlewares.map(asyncWrap),
        ...validation,
        asyncWrap(mod[method] as RequestHandler),
      );
    }

    // Any method without a handler on an existing route is 405 (with Allow) —
    // not just the seven EFC names, so TRACE/PROPFIND/custom verbs don't fall
    // through to a misleading 404. Unreachable for implemented methods because
    // their layers run first.
    if (implemented.length > 0) {
      const allowHeader = implemented.join(', ');
      app.all(routePath, (req, res, next) => {
        if (isUpgrade(req)) return next();
        if (!implemented.includes(req.method as HttpMethod)) {
          traceRoute(route.urlPath)(req, res, () => {});
          res.set('Allow', allowHeader).status(405).json({ error: 'Method Not Allowed' });
        } else {
          next();
        }
      });
    }

    mounted.push({
      ...route,
      methods: implemented,
      ...(meta !== undefined && { meta }),
      ...(schema && { schema }),
      ...(websocket && { websocket }),
    });
  }

  return mounted;
}

export { asyncWrap };
