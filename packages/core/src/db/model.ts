import type { ModelCRUD, ModelOptions, ModelSchema } from '../types.js';
import { normalizeSchema } from './schema.js';
import { getDbEngine, registerModel } from './engine.js';
import { mongoModel, type EngineModel } from './mongo-model.js';
import { pgModel } from './pg-model.js';

/**
 * Defines a model once; it compiles to a mongoose model on MongoDB or a Drizzle table
 * on PostgreSQL — whichever engine Pre-Flight connected — the first time it is used,
 * so route files can define models at import time, before the database is up.
 */
export function defineModel<T extends object>(
  name: string,
  schema: ModelSchema,
  options: ModelOptions = {},
): ModelCRUD<T> {
  const tree = normalizeSchema(schema);
  let engineModel: EngineModel<T> | undefined;
  const impl = (): EngineModel<T> =>
    (engineModel ??=
      getDbEngine() === 'postgresql'
        ? pgModel<T>(name, tree, options)
        : mongoModel<T>(name, tree, options));

  const model: ModelCRUD<T> = {
    name,
    find: (filter, opts) => impl().find(filter, opts),
    findById: (id, opts) => impl().findById(id, opts),
    findOne: (filter, opts) => impl().findOne(filter, opts),
    create: (data) => impl().create(data),
    createMany: (data) => impl().createMany(data),
    update: (id, data) => impl().update(id, data),
    updateMany: (filter, data) => impl().updateMany(filter, data),
    delete: (id) => impl().delete(id),
    deleteMany: (filter) => impl().deleteMany(filter),
    count: (filter) => impl().count(filter),
    aggregate: (pipeline) => impl().aggregate(pipeline),
    raw: () => impl().raw(),
    sync: () => impl().sync(),
  };
  registerModel(model as unknown as ModelCRUD<object>);
  return model;
}
