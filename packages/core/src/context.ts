import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';

export interface RequestContext {
  user?: Record<string, unknown> | undefined;
  requestId?: string;
  log?: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

// Wraps one request's lifecycle in an AsyncLocalStorage context. Node propagates
// the store through the async chain the callback initiates (awaits, .then, etc.),
// so anything running as part of the same request — including a `$currentUser`
// default resolved deep inside a mongoose `.create()` call — can read it back.
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setCurrentUser(user: Record<string, unknown> | undefined): void {
  const store = storage.getStore();
  if (store) store.user = user;
}

export function getCurrentUser(): Record<string, unknown> | undefined {
  return storage.getStore()?.user;
}
