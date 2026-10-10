import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pc from 'picocolors';
import { pino, type Logger, type DestinationStream } from 'pino';
import type { LoggingConfig } from './types.js';
import { getRequestContext } from './context.js';

export type { Logger };

const LEVEL_LABELS: Record<number, string> = {
  10: pc.gray('TRACE'),
  20: pc.blue('DEBUG'),
  30: pc.green('INFO '),
  40: pc.yellow('WARN '),
  50: pc.red('ERROR'),
  60: pc.bgRed('FATAL'),
};

const OMIT = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'worker', 'reqId']);

// Dev-friendly one-line renderer, so readable output doesn't need pino-pretty or a
// transport worker thread: `12:00:01 INFO  [w2] a1b2c3d4 GET /users 200 (3ms)`.
function prettyStream(out: NodeJS.WritableStream = process.stdout): DestinationStream {
  return {
    write(line: string) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        out.write(line);
        return;
      }
      const time = new Date(rec['time'] as number).toTimeString().slice(0, 8);
      const level = LEVEL_LABELS[rec['level'] as number] ?? String(rec['level']);
      const worker = rec['worker'] !== undefined ? pc.dim(`[${String(rec['worker'])}] `) : '';
      const reqId = rec['reqId'] ? pc.magenta(String(rec['reqId']).slice(0, 8)) + ' ' : '';
      const extra = Object.entries(rec).filter(([k]) => !OMIT.has(k));
      const err = rec['err'] as { stack?: string } | undefined;
      const fields = extra
        .filter(([k]) => k !== 'err')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      out.write(
        `${pc.dim(time)} ${level} ${worker}${reqId}${String(rec['msg'] ?? '')}` +
          (fields ? ' ' + pc.dim(fields) : '') +
          (err?.stack ? '\n' + pc.red(err.stack) : '') +
          '\n',
      );
    },
  };
}

function workerLabel(): string {
  return cluster.isWorker ? `w${cluster.worker?.id ?? '?'}` : 'primary';
}

function build(config: LoggingConfig | false | undefined): Logger {
  if (config === false) return pino({ level: 'silent' });
  const opts = config ?? {};
  const pretty =
    opts.pretty ?? (process.env['NODE_ENV'] !== 'production' && process.stdout.isTTY === true);
  const base = { worker: workerLabel() };
  const level = opts.level ?? 'info';
  return pretty
    ? pino({ level, base, errorKey: 'err' }, prettyStream())
    : pino({ level, base, errorKey: 'err', timestamp: pino.stdTimeFunctions.isoTime });
}

let rootLogger: Logger = build(undefined);
let logRequests = true;

/** Called by ignite() during Pre-Flight; before that the defaults apply. */
export function configureLogger(config: LoggingConfig | false | undefined): void {
  rootLogger = build(config);
  logRequests = config !== false && (config?.requests ?? true);
}

/**
 * The logger for the current scope: inside a request it is a child carrying that
 * request's `reqId`, so everything logged while handling it can be correlated;
 * elsewhere (startup, task handlers, timers) it is the root logger.
 */
export function getLogger(): Logger {
  return getRequestContext()?.log ?? rootLogger;
}

/** Root logger proxy — always reflects the latest configureLogger() call. */
export const logger: Logger = new Proxy({} as Logger, {
  get(_t, prop) {
    const target = getLogger() as unknown as Record<PropertyKey, unknown>;
    const value = target[prop];
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  },
});

const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * Assigns the request ID (trusting a well-formed incoming `X-Request-Id`, e.g. from
 * a load balancer), echoes it back, attaches `req.id` / `req.log`, and logs one
 * line per completed request. Must run inside the request's context.
 */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const log = rootLogger.child({ reqId: id });

    req.id = id;
    req.log = log;
    res.setHeader('X-Request-Id', id);
    const ctx = getRequestContext();
    if (ctx) {
      ctx.requestId = id;
      ctx.log = log;
    }

    if (logRequests) {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode;
        const line = {
          method: req.method,
          url: req.originalUrl,
          status,
          durationMs: Math.round(durationMs * 10) / 10,
        };
        const msg = `${req.method} ${req.originalUrl} ${status}`;
        if (status >= 500) log.error(line, msg);
        else if (status >= 400) log.warn(line, msg);
        else log.info(line, msg);
      });
    }
    next();
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Request ID — the incoming `X-Request-Id` if well-formed, else a UUID. */
    id: string;
    /** Logger bound to this request's ID. */
    log: Logger;
  }
}
