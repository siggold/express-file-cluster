// Wraps mongoose connection for Pre-Flight. Throws clearly if mongoose isn't installed.
import type * as MongooseNS from 'mongoose';
import { getLogger } from '../logger.js';

let mongoose: typeof MongooseNS;

async function loadMongoose(): Promise<typeof MongooseNS> {
  if (mongoose) return mongoose;
  try {
    mongoose = await import('mongoose');
    return mongoose;
  } catch {
    throw new Error('[EFC] mongoose is not installed. Run: npm install mongoose');
  }
}

export async function connectMongo(url: string): Promise<MongooseNS.Connection> {
  const mg = await loadMongoose();
  await mg.connect(url);
  getLogger().info('MongoDB connected');
  return mg.connection;
}
