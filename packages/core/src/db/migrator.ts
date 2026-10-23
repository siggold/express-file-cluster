import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseEngine, MigrationContext } from '../types.js';

// `efc db migrate | rollback | status | seed` — engine-agnostic. Migration files run in
// filename order (timestamp prefixes keep that chronological); applied ones are recorded
// with a batch number so `rollback` can undo the most recent `migrate` as a unit.

const FILE_RE = /\.(ts|js|mts|mjs)$/;
const TABLE = 'efc_migrations';

export interface MigrationModule {
  up: (ctx: MigrationContext) => Promise<void> | void;
  down?: (ctx: MigrationContext) => Promise<void> | void;
}

export interface MigrationStatus {
  name: string;
  batch?: number;
  runAt?: Date;
}

interface Store {
  applied(): Promise<Required<MigrationStatus>[]>;
  record(name: string, batch: number): Promise<void>;
  remove(name: string): Promise<void>;
  /** Serialises concurrent `migrate` runs (e.g. several instances deploying at once). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

function mongoStore(conn: Connection): Store {
  const col = () => conn.collection(TABLE);
  return {
    async applied() {
      const docs = await col().find({}).sort({ batch: 1, name: 1 }).toArray();
      return docs.map((d) => ({
        name: d['name'] as string,
        batch: d['batch'] as number,
        runAt: d['runAt'] as Date,
      }));
    },
    async record(name, batch) {
      await col().insertOne({ name, batch, runAt: new Date() });
    },
    async remove(name) {
      await col().deleteOne({ name });
    },
    async withLock(fn) {
      // A unique index makes a concurrently re-applied migration fail loudly instead of running twice.
      await col().createIndex({ name: 1 }, { unique: true });
      return fn();
    },
  };
}

function pgStore(pool: Pool): Store {
  const ensure = () =>
    pool.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, batch integer NOT NULL, run_at timestamptz NOT NULL DEFAULT now())`,
    );
  return {
    async applied() {
      await ensure();
      const { rows } = await pool.query<{ name: string; batch: number; run_at: Date }>(
        `SELECT name, batch, run_at FROM ${TABLE} ORDER BY batch, name`,
      );
      return rows.map((r) => ({ name: r.name, batch: r.batch, runAt: r.run_at }));
    },
    async record(name, batch) {
      await pool.query(`INSERT INTO ${TABLE} (name, batch) VALUES ($1, $2)`, [name, batch]);
    },
    async remove(name) {
      await pool.query(`DELETE FROM ${TABLE} WHERE name = $1`, [name]);
    },
    async withLock(fn) {
      await ensure();
      const client: PoolClient = await pool.connect();
      try {
        await client.query(`SELECT pg_advisory_lock(hashtext('${TABLE}'))`);
        return await fn();
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('${TABLE}'))`).catch(() => {});
        client.release();
      }
    },
  };
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f) && !f.endsWith('.d.ts'))
    .sort();
}

const nameOf = (file: string) => file.replace(FILE_RE, '');

async function load<T>(dir: string, file: string): Promise<T> {
  return (await import(pathToFileURL(path.join(dir, file)).href)) as T;
}

export class Migrator {
  private readonly store: Store;
  private readonly ctx: MigrationContext;

  constructor(
    private readonly dir: string,
    engine: DatabaseEngine,
    client: unknown,
  ) {
    this.store =
      engine === 'postgresql' ? pgStore(client as Pool) : mongoStore(client as Connection);
    this.ctx = { db: client, engine };
  }

  async status(): Promise<MigrationStatus[]> {
    const applied = new Map((await this.store.applied()).map((m) => [m.name, m]));
    const files = listFiles(this.dir).map(nameOf);
    const all = new Set([...files, ...applied.keys()]);
    return [...all].sort().map((name) => applied.get(name) ?? { name });
  }

  /**
   * Runs every pending migration in one new batch; returns their names. `baseline` records
   * them as applied without running them — for a database whose schema already matches
   * (created by autoSync before the app had migrations).
   */
  async migrate(
    opts: { onRun?: (name: string) => void; baseline?: boolean } = {},
  ): Promise<string[]> {
    return this.store.withLock(async () => {
      const applied = await this.store.applied();
      const done = new Set(applied.map((m) => m.name));
      const batch = Math.max(0, ...applied.map((m) => m.batch)) + 1;
      const ran: string[] = [];
      for (const file of listFiles(this.dir)) {
        const name = nameOf(file);
        if (done.has(name)) continue;
        const mod = await load<MigrationModule>(this.dir, file);
        if (typeof mod.up !== 'function')
          throw new Error(`[EFC] Migration ${file} has no exported up()`);
        opts.onRun?.(name);
        if (!opts.baseline) await mod.up(this.ctx);
        await this.store.record(name, batch);
        ran.push(name);
      }
      return ran;
    });
  }

  /** Reverts the last `steps` batches, newest migration first; returns their names. */
  async rollback(opts: { steps?: number; onRun?: (name: string) => void } = {}): Promise<string[]> {
    return this.store.withLock(async () => {
      const applied = await this.store.applied();
      const batches = [...new Set(applied.map((m) => m.batch))]
        .sort((a, b) => b - a)
        .slice(0, opts.steps ?? 1);
      const targets = applied.filter((m) => batches.includes(m.batch)).reverse();
      const files = new Map(listFiles(this.dir).map((f) => [nameOf(f), f]));
      const reverted: string[] = [];
      for (const { name } of targets) {
        const file = files.get(name);
        if (!file) throw new Error(`[EFC] Cannot roll back ${name}: its migration file is missing`);
        const mod = await load<MigrationModule>(this.dir, file);
        if (typeof mod.down !== 'function')
          throw new Error(`[EFC] Migration ${file} has no exported down()`);
        opts.onRun?.(name);
        await mod.down(this.ctx);
        await this.store.remove(name);
        reverted.push(name);
      }
      return reverted;
    });
  }
}

/** Runs seed files (all, or only `only`) in filename order; returns their names. */
export async function runSeeds(
  dir: string,
  engine: DatabaseEngine,
  client: unknown,
  only?: string,
  onRun?: (name: string) => void,
): Promise<string[]> {
  const ctx: MigrationContext = { db: client, engine };
  const files = listFiles(dir).filter((f) => !only || nameOf(f) === only);
  if (only && files.length === 0) throw new Error(`[EFC] No seed named "${only}" in ${dir}`);
  for (const file of files) {
    const mod = await load<{
      default?: (ctx: MigrationContext) => unknown;
      seed?: (ctx: MigrationContext) => unknown;
    }>(dir, file);
    const fn = mod.default ?? mod.seed;
    if (typeof fn !== 'function')
      throw new Error(`[EFC] Seed ${file} must export a default function`);
    onRun?.(nameOf(file));
    await fn(ctx);
  }
  return files.map(nameOf);
}
