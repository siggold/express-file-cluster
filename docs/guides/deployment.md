# Deployment Guide

---

## Build step

Before deploying, compile TypeScript to JavaScript:

```bash
npm run build
# → efc build prod
```

`efc build prod` type-checks, then transpiles every file in `src/` (plus `efc.config.ts`) into `dist/`, keeping the directory tree so routes and tasks are found at runtime. The entry point for production is `dist/src/index.js`.

---

## Running in production

```bash
npm start
# → efc start prod
# → node dist/src/index.js  (NODE_ENV=production)
```

`efc start prod` sets `NODE_ENV=production` and spawns the compiled server with `node`. It does **not** read `.env` — secrets must be injected through the platform's secret management.

Stopping is graceful at every layer: `efc start prod` forwards `SIGTERM`/`SIGINT` to the server, the cluster primary relays it to each worker, and each worker stops accepting connections, finishes in-flight requests and task jobs, then exits. This works whether the signal reaches the whole process group (Ctrl+C) or only PID 1 (`docker stop`, Kubernetes).

---

## Environment variables

Set these in your deployment platform:

| Variable | Notes |
|---|---|
| `NODE_ENV` | Set to `production` — enables clustering, `Secure` cookie, production log level |
| `PORT` | Usually set by the platform (Heroku, Railway, etc.) |
| `DATABASE_URL` | Production database connection string |
| `JWT_SECRET` | Production signing key — different from dev |
| `REDIS_URL` | Required if using BullMQ (pg-boss uses `DATABASE_URL`) |
| `CORS_ORIGINS` | Your production frontend domain(s) |

---

## Migrations

Run pending migrations before the new version starts serving — as a release step on your platform, or in the container command:

```bash
npx efc db migrate --dist   # --dist: use compiled dist/src/migrations (no tsx in production)
```

On PostgreSQL concurrent `migrate` runs take an advisory lock, so it's safe if several instances run it at deploy time. See [Migrations & Seeds](./migrations.md).

## Clustering in production

With `NODE_ENV=production`, `cluster` defaults to `true`. The primary process forks `os.cpus().length` workers. To override:

```ts
ignite({ cluster: true, workers: 2 });
```

For containerised deployments where you want one process per container (and rely on the orchestrator for scaling), set:

```ts
ignite({ cluster: false });
```

Or use a single-CPU container image and let `os.cpus().length` naturally be `1`.

---

## Graceful shutdown

Always wire `gracefulShutdown` to handle SIGTERM (sent by orchestrators before replacing a pod/dyno):

```ts
ignite(config)
  .then(gracefulShutdown);
```

The default drain window is 10 seconds. Adjust for long-running requests:

```ts
  .then((server) => gracefulShutdown(server, 30_000));
```

What happens on `SIGTERM`:

1. `efc start prod` (if it's your entrypoint) forwards the signal to the server process.
2. The cluster primary relays it to every worker — orchestrators like `docker stop` and Kubernetes signal only PID 1.
3. Each worker stops accepting connections, finishes in-flight requests and running task jobs, then exits `0`.
4. The primary exits once all workers have; it force-exits after `timeoutMs + 2s` if one hangs.

Set your orchestrator's grace period (`terminationGracePeriodSeconds`, `stop_grace_period`) above `timeoutMs`.

---

## Docker

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["sh", "-c", "npx efc db migrate --dist && node dist/src/index.js"]
```

Inject environment variables via `docker run -e` or a secrets manager. Do not copy `.env` into the image.

---

## Railway / Render / Heroku

These platforms:

1. Detect `npm start` from `package.json`.
2. Inject `PORT` automatically.
3. Let you set env vars through their dashboard.

No extra configuration is needed — `npm start` (`efc start prod`) handles the rest.

---

## Health check endpoint

The scaffolder generates `src/api/health.ts`:

```ts
export const GET = async (_req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
};
```

This maps to `GET /health`. Point your load balancer / Kubernetes liveness probe at it:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

---

## Production checklist

- [ ] `NODE_ENV=production` set in the platform
- [ ] `JWT_SECRET` is a 64-byte random hex string unique to production
- [ ] `.env` is **not** copied into the Docker image or committed to git
- [ ] `CORS_ORIGINS` is set to your actual frontend domain(s)
- [ ] `gracefulShutdown` is wired in `src/index.ts`
- [ ] Health check endpoint is configured in the load balancer
- [ ] Redis is available if using BullMQ tasks (pg-boss needs only Postgres)
- [ ] `efc db migrate` runs before the new version serves traffic
- [ ] Orchestrator grace period > `gracefulShutdown` timeout
- [ ] Logs are collected from stdout (JSON lines with `reqId`)
- [ ] `efc doctor` passes locally with production-like env vars
