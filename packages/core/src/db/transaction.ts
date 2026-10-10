import type * as MongooseNS from 'mongoose';
import { currentTx, getDbEngine, runInTx } from './engine.js';
import { loadMongoose } from './mongo-model.js';
import { getOrm } from './postgres.js';

/**
 * Runs `fn` in a database transaction. Every model call inside it — however deeply
 * nested, through awaits — joins the transaction automatically; throwing rolls it all
 * back. Nested calls reuse the outer transaction.
 *
 * MongoDB transactions need a replica set (Atlas, or `mongod --replSet`).
 *
 * @example
 * await transaction(async () => {
 *   const order = await Order.create({ total: 40 });
 *   await Stock.update(itemId, { $inc: { count: -1 } });
 * });
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (currentTx()) return fn();

  if (getDbEngine() === 'postgresql') {
    let result!: T;
    await getOrm().transaction(async (tx: unknown) => {
      result = await runInTx({ engine: 'postgresql', tx }, fn);
    });
    return result;
  }

  const mg = await loadMongoose();
  const session: MongooseNS.ClientSession = await mg.connection.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await runInTx({ engine: 'mongodb', session }, fn);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
