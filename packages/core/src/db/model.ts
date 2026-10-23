import type {
  DatabaseEngine,
  InferredModel,
  ModelCRUD,
  ModelOptions,
  ModelRecord,
  ModelSchema,
} from '../types.js';
import { isHttpError } from '../errors.js';
import { normalizeSchema, timestampFields, type SchemaTree } from './schema.js';
import { currentTx, getDbEngine, registerModel } from './engine.js';
import { mongoModel, type EngineModel } from './mongo-model.js';
import { pgModel } from './pg-model.js';
import { tableNameFor } from './pg-table.js';
import { traceOps } from './query-log.js';

const ENGINE_LABEL: Record<DatabaseEngine, string> = {
  mongodb: 'MongoDB',
  postgresql: 'PostgreSQL',
};

/** For engine-native model APIs: the engine they need and the function that defined them. */
export interface NativeEngine {
  engine: DatabaseEngine;
  api: string;
  kind: string;
}

/**
 * Defines a model once; it compiles to a mongoose model on MongoDB or a Drizzle table
 * on PostgreSQL — whichever engine Pre-Flight connected — the first time it is used,
 * so route files can define models at import time, before the database is up.
 *
 * Record and create-input types are inferred from the schema
 * (`InferRecord<typeof User>`); `defineModel<User>(...)` still takes an explicit type.
 */
export function defineModel<
  T extends object = never,
  const S extends ModelSchema = ModelSchema,
  const O extends ModelOptions = ModelOptions,
>(name: string, schema: S, options?: O): InferredModel<T, S, O> {
  return createModel(name, schema, options ?? {}) as unknown as InferredModel<T, S, O>;
}

function distinctFields(tree: SchemaTree, options: ModelOptions): Set<string> {
  const ts = timestampFields(options);
  const fields = new Set(['id', ...Object.values(ts)]);
  for (const [key, node] of Object.entries(tree)) if (node.kind === 'scalar') fields.add(key);
  return fields;
}

// The operations query logging reports (not raw/sync/drop).
const MODEL_OPS = [
  'find',
  'findById',
  'findOne',
  'exists',
  'distinct',
  'create',
  'createMany',
  'update',
  'updateOne',
  'updateMany',
  'upsert',
  'delete',
  'deleteOne',
  'deleteMany',
  'count',
  'aggregate',
] as const;

const sortKey = (v: unknown) => (v instanceof Date ? v.getTime() : v) as string | number;

export function createModel<T extends object, C = Partial<T>>(
  name: string,
  schema: ModelSchema,
  options: ModelOptions,
  native?: NativeEngine,
): ModelCRUD<T, C> {
  const tree = normalizeSchema(schema, 'model', name);
  let engineModel: EngineModel<T> | undefined;
  const impl = (): EngineModel<T> => {
    if (engineModel) return engineModel;
    const engine = getDbEngine();
    if (native && native.engine !== engine) {
      throw new Error(
        `[EFC] ${name} is a ${ENGINE_LABEL[native.engine]} ${native.kind} (${native.api}) but the app is connected to ${ENGINE_LABEL[engine]} — check DATABASE_URL / config.database, or use defineModel for a model that runs on both`,
      );
    }
    engineModel =
      engine === 'postgresql'
        ? pgModel<T>(name, tree, options)
        : mongoModel<T>(name, tree, options);
    return engineModel;
  };
  // The engine guard must reject before a query, so run impl() inside the promise chain.
  const call = <R>(fn: (m: EngineModel<T>) => Promise<R>): Promise<R> =>
    Promise.resolve().then(() => fn(impl()));
  const scalarFields = distinctFields(tree, options);

  const model: ModelCRUD<T, C> = {
    name,
    find: (filter, opts) => call((m) => m.find(filter, opts)),
    findById: (id, opts) => call((m) => m.findById(id, opts)),
    findOne: (filter, opts) => call((m) => m.findOne(filter, opts)),
    exists: (filter) => call((m) => m.exists(filter)),
    distinct: (field, filter) =>
      call(async (m) => {
        if (!scalarFields.has(field)) {
          // Undeclared: absent from every record, as in filters. Declared non-scalar: refused.
          if (!(field in tree)) return [];
          throw new Error(
            `[EFC] ${name}.distinct('${field}'): only scalar fields are supported, not arrays or objects`,
          );
        }
        const values = (await m.distinct(field, filter)).filter((v) => v != null);
        return values.sort((a, b) => {
          const x = sortKey(a);
          const y = sortKey(b);
          return x < y ? -1 : x > y ? 1 : 0;
        }) as never;
      }),
    create: (data) => call((m) => m.create(data as Partial<T>)),
    createMany: (data) => call((m) => m.createMany(data as Partial<T>[])),
    update: (id, data) => call((m) => m.update(id, data)),
    updateOne: (filter, data) => call((m) => m.updateOne(filter, data)),
    updateMany: (filter, data) => call((m) => m.updateMany(filter, data)),
    upsert: (filter, create, update) =>
      call(async (m): Promise<ModelRecord<T>> => {
        const updated = await m.updateOne(filter, update);
        if (updated) return updated;
        try {
          return await m.create(create as Partial<T>);
        } catch (err) {
          // Lost a race to a concurrent upsert on a unique field: the record exists now.
          // Inside a transaction the failed insert has aborted it (PostgreSQL), so rethrow.
          if (isHttpError(err) && err.statusCode === 409 && !currentTx()) {
            const retried = await m.updateOne(filter, update);
            if (retried) return retried;
          }
          throw err;
        }
      }),
    delete: (id) => call((m) => m.delete(id)),
    deleteOne: (filter) => call((m) => m.deleteOne(filter)),
    deleteMany: (filter) => call((m) => m.deleteMany(filter)),
    count: (filter) => call((m) => m.count(filter)),
    aggregate: (pipeline) => call((m) => m.aggregate(pipeline)),
    raw: () => call((m) => m.raw()),
    sync: (opts) => call((m) => m.sync(opts)),
    drop: () => call((m) => m.drop()),
  };
  traceOps(name, model, MODEL_OPS);
  registerModel({
    name,
    sync: model.sync,
    plan: (opts) => call((m) => m.plan(opts)),
    drop: model.drop,
    findByIds: (ids) => model.find({ id: { $in: ids as string[] } } as never),
    pgTarget: () => ({ table: options.collection ?? tableNameFor(name), idKind: 'uuid' }),
  });
  return model;
}
