import type * as MongooseNS from 'mongoose';
import type { FindOptions, ModelCRUD, ModelOptions, ModelQueryOptions } from '../types.js';
import { HttpError } from '../errors.js';
import {
  ModelValidationError,
  resolveDefault,
  sequenceFields,
  type FieldNode,
  type SchemaTree,
} from './schema.js';
import { currentTx } from './engine.js';
import { notInstalled } from './postgres.js';

type AnyRecord = Record<string, unknown>;
export type EngineModel<T extends object> = Omit<ModelCRUD<T>, 'name'>;

let mongoosePromise: Promise<typeof MongooseNS> | undefined;

export function loadMongoose(): Promise<typeof MongooseNS> {
  mongoosePromise ??= import('mongoose')
    .then((mod) => ((mod as { default?: typeof MongooseNS }).default ?? mod) as typeof MongooseNS)
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

  const model = (): Promise<MongooseNS.Model<AnyRecord>> =>
    (compiled ??= loadMongoose().then((mg) => {
      if (mg.models[name]) return mg.models[name] as MongooseNS.Model<AnyRecord>;
      const schema = new mg.Schema(buildTree(tree, mg) as MongooseNS.SchemaDefinition, {
        timestamps: options.timestamps ?? true,
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
      return mg.model<AnyRecord>(name, schema);
    }));

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

    async sync() {
      const M = await model();
      await M.createCollection().catch((err: { code?: number }) => {
        if (err?.code !== 48) throw err; // 48 = NamespaceExists
      });
      await M.syncIndexes();
    },
  };
}
