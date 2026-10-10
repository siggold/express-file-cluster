import cluster from 'node:cluster';
import { getLogger } from '../logger.js';

interface ClusterOptions {
  workers?: number;
  onWorkerReady?: ((id: number) => void) | undefined;
  onWorkerCrash?: ((id: number, code: number) => void) | undefined;
}

let isShuttingDown = false;

/**
 * Returns the number of currently alive (not yet exited) cluster workers.
 * Returns `0` when running in single-process mode.
 */
export function workerCount(): number {
  return Object.keys(cluster.workers ?? {}).length;
}

export function shutdownMaster(): void {
  isShuttingDown = true;
  getLogger().info(`Cluster primary (pid=${process.pid}) shutting down, waiting for workers…`);
  if (workerCount() === 0) process.exit(0);
  // Orchestrators (docker stop, k8s) signal only PID 1 — the primary — so forward the
  // signal; each worker's gracefulShutdown drains its server and exits on its own.
  for (const worker of Object.values(cluster.workers ?? {})) {
    worker?.process.kill('SIGTERM');
  }
}

export function runMaster(options: ClusterOptions = {}): void {
  const count = options.workers ?? 1;

  getLogger().info(`Primary ${process.pid} starting ${count} workers`);

  for (let i = 0; i < count; i++) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    options.onWorkerReady?.(worker.id);
  });

  cluster.on('exit', (worker, code, signal) => {
    const exitCode = code ?? (signal ? -1 : 0);
    if (isShuttingDown) {
      getLogger().info(`Worker ${worker.id} gracefully exited`);
      if (workerCount() === 0) {
        getLogger().info('All workers exited. Primary exiting.');
        process.exit(0);
      }
      return;
    }

    getLogger().warn(`Worker ${worker.id} exited (code=${exitCode}), respawning…`);
    options.onWorkerCrash?.(worker.id, exitCode);
    cluster.fork();
  });
}

export { cluster };
