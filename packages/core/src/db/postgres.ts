import type { Pool } from 'pg';
import { getLogger } from '../logger.js';

// Pre-Flight's PostgreSQL connection: a node-postgres Pool (exposed as `db`) plus a
// Drizzle instance over it that the model adapter queries through.

/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle is an optional peer, loaded dynamically */
let pool: Pool | undefined;

/** Only a genuinely missing package becomes "not installed"; other load errors surface as-is. */
export function notInstalled(err: unknown, pkg: string, install: string): Error {
  const code = (err as { code?: string }).code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
    ? new Error(`[EFC] ${pkg} is not installed. Run: ${install}`)
    : (err as Error);
}
let orm: any;

export async function connectPostgres(url: string): Promise<Pool> {
  let PoolCtor: typeof Pool;
  try {
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: typeof Pool };
      Pool?: typeof Pool;
    };
    PoolCtor = (pg.default?.Pool ?? pg.Pool)!;
  } catch (err) {
    throw notInstalled(err, 'pg', 'npm install pg drizzle-orm');
  }
  let drizzle: (client: Pool) => unknown;
  try {
    ({ drizzle } = (await import('drizzle-orm/node-postgres')) as unknown as {
      drizzle: (client: Pool) => unknown;
    });
  } catch (err) {
    throw notInstalled(err, 'drizzle-orm', 'npm install drizzle-orm');
  }

  const next = new PoolCtor({ connectionString: url });
  // Idle-client errors (e.g. the server restarting) are emitted on the pool; unhandled
  // they would crash the process.
  next.on('error', (err) => getLogger().error({ err }, 'PostgreSQL pool error'));
  await next.query('select 1');
  pool = next;
  orm = drizzle(next);
  getLogger().info('PostgreSQL connected');
  return next;
}

export function getOrm(): any {
  if (!orm) {
    throw new Error(
      '[EFC] PostgreSQL not connected — set database/databaseUrl in ignite() (or call connectPostgres)',
    );
  }
  return orm;
}

export function getPool(): Pool {
  if (!pool) throw new Error('[EFC] PostgreSQL not connected');
  return pool;
}

export async function closePostgres(): Promise<void> {
  const p = pool;
  pool = undefined;
  orm = undefined;
  await p?.end();
}
