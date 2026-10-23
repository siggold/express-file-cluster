// Wraps mongoose connection for Pre-Flight. Throws clearly if mongoose isn't installed.
import type * as MongooseNS from 'mongoose';
import { getLogger } from '../logger.js';
import { loadMongoose } from './mongo-model.js';
import type { DatabasePoolConfig } from '../types.js';

export async function connectMongo(
  url: string,
  pool: DatabasePoolConfig = {},
): Promise<MongooseNS.Connection> {
  // loadMongoose() unwraps the CJS default export: in native ESM the namespace's own
  // `connection` binding is not the live connection, so reading it gave `undefined`.
  const mg = await loadMongoose();
  await mg.connect(url, {
    ...(pool.max !== undefined && { maxPoolSize: pool.max }),
    ...(pool.idleTimeoutMs !== undefined && { maxIdleTimeMS: pool.idleTimeoutMs }),
    ...(pool.connectionTimeoutMs !== undefined && {
      serverSelectionTimeoutMS: pool.connectionTimeoutMs,
      waitQueueTimeoutMS: pool.connectionTimeoutMs,
    }),
  });
  getLogger().info('MongoDB connected');
  return mg.connection;
}
