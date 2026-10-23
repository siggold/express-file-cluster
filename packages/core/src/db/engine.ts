import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseEngine } from '../types.js';

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

// Whether models reconcile their table/collection on first use (EFCConfig.autoSync).
let autoSync = true;

export function setAutoSync(value: boolean): void {
  autoSync = value;
}

export function isAutoSync(): boolean {
  return autoSync;
}

// Set while `efc db generate` replays migrations into its shadow schema: a migration that
// calls `Model.sync()` (the scaffolded init migration does) mirrors the models as they are
// *now*, which would hide every change from the diff — so those calls do nothing there.
let syncSuppressed = false;

export function setSyncSuppressed(value: boolean): void {
  syncSuppressed = value;
}

export function isSyncSuppressed(): boolean {
  return syncSuppressed;
}

/** One step of a generated migration. */
export interface PlanStep {
  /**
   * PostgreSQL: a SQL statement. MongoDB: a JavaScript statement run against `db` (the
   * mongoose Connection). With `check`, a query returning `n` that must be 0.
   */
  sql: string;
  /** Best-effort reverse, for the migration's `down()`; `''` = nothing to undo. */
  down?: string;
  /** PostgreSQL: skip `sql` when this query returns a row (already applied). */
  skipIf?: string;
  /** `sql` counts offending rows: the migration stops with this message (`%n` = count). */
  check?: string;
  /** Foreign keys run after every table exists. */
  phase: 'main' | 'fk';
}

/** The explicit, possibly lossy extras `efc db generate` may add to the sync plan. */
export interface PlanOptions {
  /** Drop columns the model no longer declares. */
  allowDrop?: boolean;
  /** Add NOT NULL for required fields and validate enum checks, behind row checks. */
  tighten?: boolean;
}

/** What every model API (defineModel, defineTable) registers about itself. */
export interface RegisteredModel {
  readonly name: string;
  sync(options?: { dryRun?: boolean }): Promise<string[]>;
  /** The migration steps that would bring the database in line with the model. */
  plan?(options?: PlanOptions): Promise<PlanStep[]>;
  drop(): Promise<void>;
  /** Records by id — what `populate` needs from a `ref` target. */
  findByIds(ids: unknown[]): Promise<Record<string, unknown>[]>;
  /** PostgreSQL: its table and id strategy — what a foreign key to it needs. */
  pgTarget?(): { table: string; idKind: 'uuid' | 'serial' | 'bigserial' };
  /** defineTable only: its runtime, for `include` from other tables. */
  tableRuntime?(): unknown;
}

// Every defined model by name, so `populate` can resolve a `ref` on either engine
// and `efc db` commands can sync everything that was imported.
const registry = new Map<string, RegisteredModel>();

export function registerModel(model: RegisteredModel): void {
  registry.set(model.name, model);
}

export function getRegisteredModel(name: string): RegisteredModel | undefined {
  return registry.get(name);
}

export function registeredModels(): RegisteredModel[] {
  return [...registry.values()];
}

// ── Transactions ─────────────────────────────────────────────────────────────

/** The open transaction for the current async scope: a mongoose session or a Drizzle tx. */
export type TxHandle =
  | { engine: 'mongodb'; session: unknown }
  | {
      engine: 'postgresql';
      tx: unknown;
      /** Work to run once the transaction has committed (e.g. deferred foreign keys). */
      afterCommit: (() => void)[];
    };

const txStorage = new AsyncLocalStorage<TxHandle>();

export function currentTx(): TxHandle | undefined {
  return txStorage.getStore();
}

export function runInTx<T>(handle: TxHandle, fn: () => Promise<T>): Promise<T> {
  return txStorage.run(handle, fn);
}
