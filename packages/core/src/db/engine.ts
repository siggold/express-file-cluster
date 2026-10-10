import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseEngine, ModelCRUD } from '../types.js';

// Which adapter defineModel() compiles to. Set during Pre-Flight from
// config.database / the DATABASE_URL scheme; MongoDB until then, which keeps code
// that connects mongoose itself (tests, scripts) working without ignite().
let engine: DatabaseEngine | undefined;

export function setDbEngine(value: DatabaseEngine): void {
  engine = value;
}

export function getDbEngine(): DatabaseEngine {
  return engine ?? 'mongodb';
}

// Every defined model by name, so `populate` can resolve a `ref` on either engine
// and `efc db` commands can sync everything that was imported.
const registry = new Map<string, ModelCRUD<object>>();

export function registerModel(model: ModelCRUD<object>): void {
  registry.set(model.name, model);
}

export function getRegisteredModel(name: string): ModelCRUD<object> | undefined {
  return registry.get(name);
}

export function registeredModels(): ModelCRUD<object>[] {
  return [...registry.values()];
}

// ── Transactions ─────────────────────────────────────────────────────────────

/** The open transaction for the current async scope: a mongoose session or a Drizzle tx. */
export type TxHandle =
  | { engine: 'mongodb'; session: unknown }
  | { engine: 'postgresql'; tx: unknown };

const txStorage = new AsyncLocalStorage<TxHandle>();

export function currentTx(): TxHandle | undefined {
  return txStorage.getStore();
}

export function runInTx<T>(handle: TxHandle, fn: () => Promise<T>): Promise<T> {
  return txStorage.run(handle, fn);
}
