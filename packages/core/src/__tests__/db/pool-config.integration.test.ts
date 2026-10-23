import { describe, it, expect } from 'vitest';
import { connectPostgres, closePostgres } from '../../db/postgres.js';
import { connectMongo } from '../../db/mongo.js';
import { loadMongoose } from '../../db/mongo-model.js';

// `databasePool` reaches each driver under its own option names. Skips a database that
// isn't reachable.
const PG_URL = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test';
const MONGO_URL = process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_pool_test';

async function reachablePg(url: string): Promise<boolean> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function reachableMongo(url: string): Promise<boolean> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

const pgUp = await reachablePg(PG_URL);
const mongoUp = await reachableMongo(MONGO_URL);

describe('databasePool', () => {
  it.skipIf(!pgUp)('sets max, idle and connection timeouts on the pg Pool', async () => {
    const pool = await connectPostgres(PG_URL, {
      max: 3,
      idleTimeoutMs: 1234,
      connectionTimeoutMs: 2345,
    });
    try {
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts).toMatchObject({
        max: 3,
        idleTimeoutMillis: 1234,
        connectionTimeoutMillis: 2345,
      });
    } finally {
      await closePostgres();
    }
  });

  it.skipIf(!pgUp)('keeps pg defaults when not set', async () => {
    const pool = await connectPostgres(PG_URL);
    try {
      expect((pool as unknown as { options: Record<string, unknown> }).options['max']).toBe(10);
    } finally {
      await closePostgres();
    }
  });

  it.skipIf(!mongoUp)(
    'sets maxPoolSize, maxIdleTimeMS and timeouts on the mongoose client',
    async () => {
      const conn = await connectMongo(MONGO_URL, {
        max: 4,
        idleTimeoutMs: 5000,
        connectionTimeoutMs: 6000,
      });
      try {
        const opts = conn.getClient().options as unknown as Record<string, unknown>;
        expect(opts).toMatchObject({
          maxPoolSize: 4,
          maxIdleTimeMS: 5000,
          serverSelectionTimeoutMS: 6000,
          waitQueueTimeoutMS: 6000,
        });
      } finally {
        await (await loadMongoose()).disconnect();
      }
    },
  );
});
