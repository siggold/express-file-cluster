// Thread-local DB client populated during Pre-Flight.
// The Proxy ensures callers import `db` once and never null-check it —
// it throws with a helpful message if accessed before Pre-Flight completes.

type AnyClient = Record<string, unknown>;

let _client: AnyClient | null = null;

export function setDbClient(client: AnyClient): void {
  _client = client;
}

export function getDbClient(): AnyClient {
  if (!_client) {
    throw new Error('[EFC] db not ready — accessed before Pre-Flight completed');
  }
  return _client;
}

export const db: AnyClient = new Proxy({} as AnyClient, {
  get(_target, prop: string) {
    const client = getDbClient();
    const value = client[prop];
    // Bind methods to the real client (pg Pool, mongoose Connection) — called through the
    // proxy, `this` would be the proxy and break clients that rely on their own fields.
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
  set(_target, prop: string, value: unknown) {
    getDbClient()[prop] = value;
    return true;
  },
});

export { connectMongo } from './mongo.js';
export { connectPostgres } from './postgres.js';
export { defineModel } from './model.js';
