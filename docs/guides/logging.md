# Logging & Request IDs

EFC logs through [pino](https://getpino.io): structured JSON in production, readable one-line output in a development terminal. Every request gets an ID that follows it through every log line.

---

## Configuration

```ts
ignite({
  ...config,
  logging: {
    level: 'info',      // trace | debug | info | warn | error | fatal | silent
    pretty: undefined,  // default: true in a non-production TTY, JSON otherwise
    requests: true,     // one line per completed request
  },
});
```

`logging: false` silences framework logs entirely (request IDs are still assigned).

---

## Request IDs

Each request gets an ID — a well-formed incoming `X-Request-Id` header (e.g. from your load balancer: letters, digits, `.`, `:`, `-`, `_`, up to 128 chars) or a fresh UUID. It is:

- echoed back in the `X-Request-Id` response header,
- available as `req.id`,
- bound to a child logger, `req.log`, and to `getLogger()` anywhere in the request's async chain — models, helpers, anything awaited from the handler.

```ts
import { getLogger } from 'express-file-cluster';

export async function chargeCard(orderId: string) {
  getLogger().info({ orderId }, 'charging card'); // carries the current request's reqId
}
```

Outside a request (startup, task handlers, timers) `getLogger()` returns the root logger. `logger` is a convenience proxy for `getLogger()`.

---

## Request lines

With `requests: true`, every completed request logs method, URL, status and duration — at `info` for < 400, `warn` for 4xx, `error` for 5xx:

```
12:00:01 INFO  [w2] 3f9c2a1b GET /v1/api/users 200 method=GET url=/v1/api/users status=200 durationMs=3.4
```

In production the same record is JSON:

```json
{"level":30,"time":"2026-10-10T12:00:01.123Z","worker":"w2","reqId":"3f9c2a1b-…","method":"GET","url":"/v1/api/users","status":200,"durationMs":3.4,"msg":"GET /v1/api/users 200"}
```

`worker` is `primary` or `w<N>` for cluster worker N, so interleaved output from many workers stays attributable.

---

## Errors

Unhandled errors are logged at `error` with the request ID and full stack (`err`) before the 500 response is sent. Task failures log the task name, job ID and attempt number.

---

## Shipping logs

JSON lines on stdout is what log collectors (Datadog, Loki, CloudWatch, Vector) expect — no transport configuration needed. For custom pino transports, set `pretty: false` and pipe stdout.
