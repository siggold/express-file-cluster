import type * as MongooseNS from 'mongoose';
import type { Filter, FindOptions, ModelCRUD, ModelOptions, ModelQueryOptions } from '../types.js';
import { HttpError } from '../errors.js';
import {
  ModelValidationError,
  resolveDefault,
  sequenceFields,
  type FieldNode,
  type SchemaTree,
} from './schema.js';
import {
  currentTx,
  isAutoSync,
  isSyncSuppressed,
  type PlanOptions,
  type PlanStep,
} from './engine.js';
import { notInstalled } from './postgres.js';
import { getLogger } from '../logger.js';
import { countStatement, untracked, whenQueryTracking } from './query-log.js';

type AnyRecord = Record<string, unknown>;
/** What each engine adapter implements; `defineModel` adds `name`, `upsert` and the `distinct` rules. */
export type EngineModel<T extends object> = Omit<ModelCRUD<T>, 'name' | 'upsert' | 'distinct'> & {
  distinct(field: string, filter?: Filter<T>): Promise<unknown[]>;
  plan(options?: PlanOptions): Promise<PlanStep[]>;
};

let mongoosePromise: Promise<typeof MongooseNS> | undefined;

export function loadMongoose(): Promise<typeof MongooseNS> {
  mongoosePromise ??= import('mongoose')
    .then((mod) => ((mod as { default?: typeof MongooseNS }).default ?? mod) as typeof MongooseNS)
    .then((mg) => {
      // Count each collection call for query logging. mongoose has a single debug hook,
      // so it is only taken while query logging (or a test listener) is on.
      whenQueryTracking(() => mg.set('debug', countStatement));
      return mg;
    })
    .catch((err: unknown) => {
      mongoosePromise = undefined;
      throw notInstalled(err, 'mongoose', 'npm install mongoose');
    });
  return mongoosePromise;
}

// ── Schema compilation ───────────────────────────────────────────────────────

function ctor(type: string, mg: typeof MongooseNS): unknown {
  switch (type) {
    case 'string':
      return String;
    case 'number':
      return Number;
    case 'boolean':
      return Boolean;
    case 'date':
      return Date;
    case 'objectId':
      return mg.Schema.Types.ObjectId;
  }
  return mg.Schema.Types.Mixed;
}

function rules(node: FieldNode, mg: typeof MongooseNS): AnyRecord {
  const d = node.def;
  const entry: AnyRecord = {};
  if (d.required !== undefined) entry['required'] = d.required;
  if (d.unique !== undefined) entry['unique'] = d.unique;
  if (d.index !== undefined) entry['index'] = d.index;
  if (d.default !== undefined)
    entry['default'] = resolveDefault(d.default, () => new mg.Types.ObjectId());
  if (d.enum !== undefined) entry['enum'] = d.enum;
  if (d.min !== undefined) entry['min'] = d.min;
  if (d.max !== undefined) entry['max'] = d.max;
  if (d.minLength !== undefined) entry['minlength'] = d.minLength;
  if (d.maxLength !== undefined) entry['maxlength'] = d.maxLength;
  if (d.match !== undefined) entry['match'] = d.match;
  if (d.validate !== undefined) {
    const check = d.validate;
    // mongoose validators return booleans; throwing lets a returned string become the message.
    entry['validate'] = {
      validator: async (v: unknown) => {
        const result = await check(v);
        if (result === true) return true;
        throw new Error(typeof result === 'string' ? result : 'is invalid');
      },
    };
  }
  return entry;
}

function buildNode(node: FieldNode, mg: typeof MongooseNS): unknown {
  switch (node.kind) {
    case 'scalar': {
      const entry: AnyRecord = { type: ctor(node.type, mg), ...rules(node, mg) };
      if (node.type === 'objectId' && node.def.ref !== undefined) entry['ref'] = node.def.ref;
      return entry;
    }
    case 'json':
      return { type: mg.Schema.Types.Mixed, ...rules(node, mg) };
    case 'object':
      // A single nested subdocument: inner `required` only applies when the object is present.
      return {
        type: new mg.Schema(buildTree(node.fields, mg), { _id: false }),
        ...rules(node, mg),
      };
    case 'array': {
      let item: unknown;
      if (node.item.kind === 'object') item = new mg.Schema(buildTree(node.item.fields, mg));
      else if (node.item.kind === 'json') item = mg.Schema.Types.Mixed;
      else item = buildNode(node.item, mg);
      return { type: [item], ...rules(node, mg) };
    }
  }
}

function buildTree(tree: SchemaTree, mg: typeof MongooseNS): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, node] of Object.entries(tree)) out[key] = buildNode(node, mg);
  return out;
}

// ── Sequences ────────────────────────────────────────────────────────────────

const COUNTER_MODEL_NAME = '__EFCCounter__';

interface CounterDoc {
  _id: string;
  seq: number;
}

function getCounterModel(mg: typeof MongooseNS): MongooseNS.Model<CounterDoc> {
  if (mg.models[COUNTER_MODEL_NAME])
    return mg.models[COUNTER_MODEL_NAME] as MongooseNS.Model<CounterDoc>;
  const counterSchema = new mg.Schema<CounterDoc>(
    { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
    { collection: 'efc_counters', versionKey: false },
  );
  return mg.model<CounterDoc>(COUNTER_MODEL_NAME, counterSchema);
}

// Atomic $inc + upsert — safe under concurrent inserts across workers/processes.
async function nextSequence(mg: typeof MongooseNS, key: string): Promise<number> {
  const doc = await getCounterModel(mg)
    .findByIdAndUpdate(key, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true })
    .lean();
  return (doc as unknown as CounterDoc).seq;
}

// ── Records & errors ─────────────────────────────────────────────────────────

// Plain objects carrying `_id` (the record, populated references, embedded array
// items) get a string `id` too; ObjectIds, Dates and other class instances pass through.
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (
    value == null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(value as AnyRecord)) out[k] = normalise(v);
  if ('_id' in out) out['id'] = String(out['_id']);
  return out;
}

function translateError(model: string, err: unknown): never {
  const e = err as {
    name?: string;
    code?: number;
    errors?: Record<string, { message: string; path?: string }>;
    keyValue?: AnyRecord;
    path?: string;
    message?: string;
  };
  if (e?.name === 'ValidationError' && e.errors) {
    throw new ModelValidationError(
      model,
      Object.entries(e.errors).map(([path, v]) => ({
        path,
        message: v.message.replace(
          /^Validator failed for path `[^`]+` with value `[^`]*`$/,
          'is invalid',
        ),
      })),
    );
  }
  if (e?.name === 'CastError') {
    throw new ModelValidationError(model, [
      { path: e.path ?? '', message: e.message ?? 'invalid value' },
    ]);
  }
  if (e?.code === 11000) {
    const field = Object.keys(e.keyValue ?? {})[0] ?? 'field';
    throw new HttpError(409, `${model} with this ${field} already exists`);
  }
  throw err;
}

function isCastErrorOnId(err: unknown): boolean {
  const e = err as { name?: string; path?: string };
  return e?.name === 'CastError' && e.path === '_id';
}

function mapFilter(filter: AnyRecord | undefined): AnyRecord {
  if (!filter) return {};
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or') out[k] = (v as AnyRecord[]).map(mapFilter);
    else out[k === 'id' ? '_id' : k] = v;
  }
  return out;
}

function mapSort(sort: FindOptions['sort']): Record<string, 1 | -1> | undefined {
  if (!sort) return undefined;
  const out: Record<string, 1 | -1> = {};
  for (const [k, v] of Object.entries(sort))
    out[k === 'id' ? '_id' : k] = v === -1 || v === 'desc' ? -1 : 1;
  return out;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export function mongoModel<T extends object>(
  name: string,
  tree: SchemaTree,
  options: ModelOptions,
): EngineModel<T> {
  let compiled: Promise<MongooseNS.Model<AnyRecord>> | undefined;

  // Compiled outside the calling operation, so collection/index creation isn't counted
  // as that operation's statements (as on PostgreSQL, where sync uses its own client).
  const model = (): Promise<MongooseNS.Model<AnyRecord>> =>
    (compiled ??= untracked(() =>
      loadMongoose().then(async (mg) => {
        if (mg.models[name]) return mg.models[name] as MongooseNS.Model<AnyRecord>;
        const schema = new mg.Schema(buildTree(tree, mg) as MongooseNS.SchemaDefinition, {
          timestamps: options.timestamps ?? true,
          // autoSync: false hands collection and index creation to migrations, on MongoDB too.
          autoIndex: isAutoSync(),
          autoCreate: isAutoSync(),
          ...(options.collection !== undefined && { collection: options.collection }),
        });
        for (const idx of options.indexes ?? []) {
          schema.index(idx.fields as Record<string, 1 | -1 | 'text'>, {
            ...(idx.unique !== undefined && { unique: idx.unique }),
            ...(idx.expireAfterSeconds !== undefined && {
              expireAfterSeconds: idx.expireAfterSeconds,
            }),
            ...(idx.name !== undefined && { name: idx.name }),
          });
        }
        const sequences = sequenceFields(name, tree);
        if (sequences.length > 0) {
          // pre('validate'), not pre('save'): required checks run before save hooks, so
          // assigning here is the only way a sequence field can also be `required: true`.
          schema.pre('validate', async function (this: MongooseNS.Document) {
            if (!this.isNew) return;
            for (const { path, key } of sequences) {
              if (this.get(path) == null) this.set(path, await nextSequence(mg, key));
            }
          });
        }
        const M = mg.model<AnyRecord>(name, schema);
        if (isAutoSync()) {
          // Like PostgreSQL's first-use sync: queries wait until the collection and its
          // indexes exist, so a unique index is enforced from the very first write. An index
          // that can't be built (e.g. duplicates already stored) is logged, not fatal — the
          // model keeps working as it did before, without that index.
          await M.init().catch((err: unknown) => {
            getLogger().warn(
              { model: name, err: (err as Error).message },
              `${name}: could not build its indexes — fix the data, then run efc db sync`,
            );
          });
        }
        return M;
      }),
    ));

  const session = (): { session?: MongooseNS.ClientSession } => {
    const tx = currentTx();
    return tx?.engine === 'mongodb' ? { session: tx.session as MongooseNS.ClientSession } : {};
  };

  const applyQueryOptions = <Q extends MongooseNS.Query<unknown, unknown>>(
    q: Q,
    opts?: FindOptions | ModelQueryOptions,
  ): Q => {
    if (opts?.populate) q.populate(opts.populate);
    if (opts?.select) q.select(opts.select.join(' '));
    const f = opts as FindOptions | undefined;
    const sort = mapSort(f?.sort);
    if (sort) q.sort(sort);
    if (f?.skip !== undefined) q.skip(f.skip);
    if (f?.limit !== undefined) q.limit(f.limit);
    return q;
  };

  const guard = async <R>(fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn();
    } catch (err) {
      return translateError(name, err);
    }
  };

  type Rec = T & { id: string };

  return {
    find: (filter, opts) =>
      guard(async () => {
        const M = await model();
        const docs = await applyQueryOptions(
          M.find(mapFilter(filter as AnyRecord), null, session()),
          opts,
        ).lean();
        return normalise(docs) as Rec[];
      }),

    async findById(id, opts) {
      try {
        const M = await model();
        const doc = await applyQueryOptions(M.findById(id, null, session()), opts).lean();
        return doc ? (normalise(doc) as Rec) : null;
      } catch (err) {
        if (isCastErrorOnId(err)) return null; // malformed id → not found
        return translateError(name, err);
      }
    },

    findOne: (filter, opts) =>
      guard(async () => {
        const M = await model();
        const doc = await applyQueryOptions(
          M.findOne(mapFilter(filter as AnyRecord), null, session()),
          opts,
        ).lean();
        return doc ? (normalise(doc) as Rec) : null;
      }),

    create: (data) =>
      guard(async () => {
        const M = await model();
        const [doc] = await M.create([data as AnyRecord], session());
        return normalise(doc!.toObject()) as Rec;
      }),

    exists: (filter) =>
      guard(async () => {
        const M = await model();
        return (
          (await M.exists(mapFilter(filter as AnyRecord)).session(session().session ?? null)) !==
          null
        );
      }),

    distinct: (field, filter) =>
      guard(async () => {
        const mg = await loadMongoose();
        const M = await model();
        const values: unknown[] = await M.distinct(
          field === 'id' ? '_id' : field,
          mapFilter(filter as AnyRecord),
        ).session(session().session ?? null);
        return values.map((v) => (v instanceof mg.Types.ObjectId ? String(v) : v));
      }),

    createMany: (data) =>
      guard(async () => {
        const M = await model();
        if (data.length === 0) return [];
        const docs = await M.create(data as AnyRecord[], { ...session(), ordered: true });
        return docs.map((d) => normalise(d.toObject()) as Rec);
      }),

    async update(id, data) {
      try {
        const M = await model();
        const doc = await M.findByIdAndUpdate(id, data as AnyRecord, {
          returnDocument: 'after',
          runValidators: true,
          ...session(),
        }).lean();
        return doc ? (normalise(doc) as Rec) : null;
      } catch (err) {
        if (isCastErrorOnId(err)) return null;
        return translateError(name, err);
      }
    },

    updateOne: (filter, data) =>
      guard(async () => {
        const M = await model();
        const doc = await M.findOneAndUpdate(mapFilter(filter as AnyRecord), data as AnyRecord, {
          returnDocument: 'after',
          runValidators: true,
          ...session(),
        }).lean();
        return doc ? (normalise(doc) as Rec) : null;
      }),

    updateMany: (filter, data) =>
      guard(async () => {
        const M = await model();
        const r = await M.updateMany(mapFilter(filter as AnyRecord), data as AnyRecord, {
          runValidators: true,
          ...session(),
        });
        return r.modifiedCount;
      }),

    async delete(id) {
      try {
        const M = await model();
        await M.findByIdAndDelete(id, session());
      } catch (err) {
        if (isCastErrorOnId(err)) return;
        translateError(name, err);
      }
    },

    deleteOne: (filter) =>
      guard(async () => {
        const M = await model();
        const doc = await M.findOneAndDelete(mapFilter(filter as AnyRecord), session()).lean();
        return doc ? (normalise(doc) as Rec) : null;
      }),

    deleteMany: (filter) =>
      guard(async () => {
        const M = await model();
        const r = await M.deleteMany(mapFilter(filter as AnyRecord), session());
        return r.deletedCount;
      }),

    count: (filter) =>
      guard(async () => {
        const M = await model();
        return M.countDocuments(mapFilter(filter as AnyRecord), session());
      }),

    aggregate: (pipeline) =>
      guard(async () => {
        const M = await model();
        const agg = M.aggregate(pipeline as unknown as MongooseNS.PipelineStage[]);
        const s = session().session;
        if (s) agg.session(s);
        return (await agg) as never;
      }),

    raw: () => model(),

    async sync(opts) {
      if (isSyncSuppressed()) return [];
      const M = await model();
      const changes: string[] = [];
      const exists =
        (await M.db.db!.listCollections({ name: M.collection.collectionName }).toArray()).length >
        0;
      if (!exists) changes.push(`createCollection ${M.collection.collectionName}`);
      const diff = await M.diffIndexes().catch(() => ({ toDrop: [], toCreate: [] }));
      for (const idx of diff.toDrop) changes.push(`dropIndex ${String(idx)}`);
      for (const idx of diff.toCreate) changes.push(`createIndex ${JSON.stringify(idx)}`);
      if (opts?.dryRun) return changes;
      if (!exists) {
        await M.createCollection().catch((err: { code?: number }) => {
          if (err?.code !== 48) throw err; // 48 = NamespaceExists
        });
      }
      await M.syncIndexes();
      return changes;
    },

    // MongoDB has no columns: a migration creates the collection, builds and drops
    // indexes, and moves `renamedFrom` fields in the stored documents.
    async plan() {
      const M = await model();
      const col = M.collection.collectionName;
      const J = (v: unknown) => JSON.stringify(v);
      const on = `db.collection(${J(col)})`;
      const steps: PlanStep[] = [];
      const exists = (await M.db.db!.listCollections({ name: col }).toArray()).length > 0;
      if (!exists) {
        steps.push({
          phase: 'main',
          sql: `await db.createCollection(${J(col)}).catch((err) => { if (err?.code !== 48) throw err; });`,
          down: `await db.dropCollection(${J(col)}).catch((err) => { if (err?.code !== 26) throw err; });`,
        });
      }
      const live = exists ? await M.collection.indexes() : [];
      const diff = await M.diffIndexes().catch(() => ({ toDrop: [], toCreate: [] }));
      for (const idx of diff.toDrop) {
        const spec = live.find((i) => i.name === idx);
        const { key, name: idxName, ...rest } = (spec ?? {}) as Record<string, unknown>;
        delete rest['v'];
        steps.push({
          phase: 'main',
          sql: `await ${on}.dropIndex(${J(idx)}).catch((err) => { if (err?.code !== 27) throw err; });`,
          ...(key !== undefined && {
            down: `await ${on}.createIndex(${J(key)}, ${J({ ...rest, name: idxName })});`,
          }),
        });
      }
      // Renames between dropping stale indexes (a unique index on the old name would see
      // duplicate nulls) and building new ones (which must see the moved values).
      for (const [field, node] of Object.entries(tree)) {
        const from = node.def.renamedFrom;
        if (from === undefined) continue;
        const move = (a: string, b: string) =>
          `await ${on}.updateMany({ ${J(a)}: { $exists: true }, ${J(b)}: { $exists: false } }, { $rename: { ${J(a)}: ${J(b)} } });`;
        steps.push({ phase: 'main', sql: move(from, field), down: move(field, from) });
      }
      const declared = M.schema.indexes();
      for (const keys of diff.toCreate as Record<string, unknown>[]) {
        const found = declared.find(([k]: [unknown, unknown]) => J(k) === J(keys));
        const opts: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(found?.[1] ?? {}))
          if (
            [
              'unique',
              'sparse',
              'expireAfterSeconds',
              'name',
              'partialFilterExpression',
              'weights',
            ].includes(k)
          )
            opts[k] = v;
        const idxName =
          (opts['name'] as string | undefined) ??
          Object.entries(keys)
            .map(([k, v]) => `${k}_${String(v)}`)
            .join('_');
        steps.push({
          phase: 'main',
          sql: `await ${on}.createIndex(${J(keys)}, ${J({ ...opts, name: idxName })});`,
          down: `await ${on}.dropIndex(${J(idxName)}).catch(() => {});`,
        });
      }
      return steps;
    },

    async drop() {
      const M = await model();
      await M.collection.drop().catch((err: { code?: number }) => {
        if (err?.code !== 26) throw err; // 26 = NamespaceNotFound
      });
    },
  };
}
