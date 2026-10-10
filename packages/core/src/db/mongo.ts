// Wraps mongoose connection for Pre-Flight. Throws clearly if mongoose isn't installed.
import type * as MongooseNS from 'mongoose';
import { getLogger } from '../logger.js';
import { loadMongoose } from './mongo-model.js';

export async function connectMongo(url: string): Promise<MongooseNS.Connection> {
  // loadMongoose() unwraps the CJS default export: in native ESM the namespace's own
  // `connection` binding is not the live connection, so reading it gave `undefined`.
  const mg = await loadMongoose();
  await mg.connect(url);
  getLogger().info('MongoDB connected');
  return mg.connection;
}
