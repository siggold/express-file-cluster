/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle is an optional peer, loaded dynamically */
import { randomUUID } from 'node:crypto';
import type { FindOptions, ModelOptions, ModelQueryOptions } from '../types.js';
import { HttpError } from '../errors.js';
import {
  applyDefaults,
  ModelValidationError,
  refFields,
  sequenceFields,
  timestampFields,
  validateTree,
  type FieldIssue,
  type FieldNode,
  type SchemaTree,
} from './schema.js';
import { currentTx, getRegisteredModel } from './engine.js';
import { getOrm } from './postgres.js';
import type { EngineModel } from './mongo-model.js';

type AnyRecord = Record<string, unknown>;

interface Drizzle {
  sql: any;
  pgCore: any;
}

let drizzlePromise: Promise<Drizzle> | undefined;

function loadDrizzle(): Promise<Drizzle> {
  drizzlePromise ??= Promise.all([import('drizzle-orm'), import('drizzle-orm/pg-core')])
    .then(([orm, pgCore]) => ({ sql: (orm as any).sql, pgCore }))
    .catch(() => {
      drizzlePromise = undefined;
      throw new Error('[EFC] drizzle-orm is not installed. Run: npm install pg drizzle-orm');
    });
  return drizzlePromise;
}

/** mongoose-style collection naming so both engines agree: User → users, Category → categories. */
export function tableNameFor(model: string): string {
  const lower = model.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(lower)) return lower + 'es';
  return lower + 's';
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const sequenceName = (key: string) => `efc_seq_${key.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()}`;

type ColumnKind = 'text' | 'double' | 'bigint' | 'boolean' | 'timestamptz' | 'uuid' | 'jsonb';

function columnKind(node: FieldNode): ColumnKind {
  if (node.kind !== 'scalar') return 'jsonb';
  if (node.def.sequence) return 'bigint';
  switch (node.type) {
    case 'string':
      return 'text';
    case 'number':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'timestamptz';
    case 'objectId':
      return 'uuid';
  }
}

const SQL_TYPE: Record<ColumnKind, string> = {
  text: 'text',
  double: 'double precision',
  bigint: 'bigint',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
  uuid: 'uuid',
  jsonb: 'jsonb',
};

function literal(v: string | number): string {
  return typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;
}

export function pgModel<T extends object>(
  name: string,
  tree: SchemaTree,
  options: ModelOptions,
): EngineModel<T> {
  const table = options.collection ?? tableNameFor(name);
  const ts = timestampFields(options);
  const sequences = sequenceFields(name, tree);
  const sequenceKeys = new Map(sequences.map((s) => [s.path, s.key]));
  const refs = refFields(tree);
  const columns = new Map<string, ColumnKind>([['id', 'uuid']]);
  for (const [key, node] of Object.entries(tree)) columns.set(key, columnKind(node));
  if (ts.createdAt) columns.set(ts.createdAt, 'timestamptz');
  if (ts.updatedAt) columns.set(ts.updatedAt, 'timestamptz');

  let compiled: Promise<{ t: any; sql: any }> | undefined;
  const compile = () =>
    (compiled ??= loadDrizzle().then(({ sql, pgCore }) => {
      const cols: AnyRecord = {};
      for (const [key, kind] of columns) {
        const c =
          kind === 'text'
            ? pgCore.text(key)
            : kind === 'double'
              ? pgCore.doublePrecision(key)
              : kind === 'bigint'
                ? pgCore.bigint(key, { mode: 'number' })
                : kind === 'boolean'
                  ? pgCore.boolean(key)
                  : kind === 'timestamptz'
                    ? pgCore.timestamp(key, { withTimezone: true, mode: 'date' })
                    : kind === 'uuid'
                      ? pgCore.uuid(key)
                      : pgCore.jsonb(key);
        cols[key] = key === 'id' ? c.primaryKey().defaultRandom() : c;
      }
      return { t: pgCore.pgTable(table, cols), sql };
    }));

  const client = () => {
    const tx = currentTx();
    return tx?.engine === 'postgresql' ? tx.tx : getOrm();
  };

  // ── filters ────────────────────────────────────────────────────────────────

  const columnFor = (t: any, field: string) => {
    if (!columns.has(field))
      throw new ModelValidationError(name, [{ path: field, message: 'unknown field' }]);
    return t[field];
  };

  const toDb = (field: string, value: unknown): unknown =>
    columns.get(field) === 'timestamptz' && value != null && !(value instanceof Date)
      ? new Date(value as string)
      : value;

  function condition(sql: any, t: any, path: string, cond: unknown): any {
    const [field, ...rest] = path.split('.');
    const col = columnFor(t, field!);
    const kind = columns.get(field!);
    const isOps =
      cond != null &&
      typeof cond === 'object' &&
      !Array.isArray(cond) &&
      !(cond instanceof Date) &&
      !(cond instanceof RegExp) &&
      Object.keys(cond).some((k) => k.startsWith('$'));

    // Expression for the compared value: a column, or a text/number extraction from jsonb.
    const jsonPath = rest.length > 0 ? `{${rest.join(',')}}` : undefined;
    const exprFor = (sample: unknown) =>
      jsonPath === undefined
        ? col
        : typeof sample === 'number'
          ? sql`((${col} #>> ${jsonPath})::double precision)`
          : typeof sample === 'boolean'
            ? sql`((${col} #>> ${jsonPath})::boolean)`
            : sql`(${col} #>> ${jsonPath})`;

    const eqCond = (v: unknown) => {
      if (v === null) return jsonPath ? sql`(${col} #> ${jsonPath}) is null` : sql`${col} is null`;
      if (kind === 'jsonb' && jsonPath === undefined) {
        // Array fields match when they contain the value (MongoDB semantics); objects match exactly.
        return Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))
          ? sql`${col} = ${JSON.stringify(v)}::jsonb`
          : sql`${col} @> ${JSON.stringify([v])}::jsonb`;
      }
      return sql`${exprFor(v)} = ${jsonPath ? v : toDb(field!, v)}`;
    };

    if (!isOps) return eqCond(cond);

    const parts: any[] = [];
    for (const [op, v] of Object.entries(cond as AnyRecord)) {
      const e = exprFor(Array.isArray(v) ? v[0] : v);
      const val = jsonPath ? v : toDb(field!, v);
      switch (op) {
        case '$eq':
          parts.push(eqCond(v));
          break;
        case '$ne':
          parts.push(v === null ? sql`${e} is not null` : sql`(${e} is null or ${e} <> ${val})`);
          break;
        case '$gt':
          parts.push(sql`${e} > ${val}`);
          break;
        case '$gte':
          parts.push(sql`${e} >= ${val}`);
          break;
        case '$lt':
          parts.push(sql`${e} < ${val}`);
          break;
        case '$lte':
          parts.push(sql`${e} <= ${val}`);
          break;
        case '$in':
        case '$nin': {
          const list = (v as unknown[]).map((x) => (jsonPath ? x : toDb(field!, x)));
          if (list.length === 0) {
            parts.push(op === '$in' ? sql`false` : sql`true`);
            break;
          }
          const inList =
            kind === 'jsonb' && !jsonPath
              ? sql.join(
                  list.map((x) => sql`${col} @> ${JSON.stringify([x])}::jsonb`),
                  sql` or `,
                )
              : sql`${e} in (${sql.join(
                  list.map((x) => sql`${x}`),
                  sql`, `,
                )})`;
          parts.push(op === '$in' ? sql`(${inList})` : sql`not (${inList})`);
          break;
        }
        case '$exists':
          parts.push(
            v ? sql`${exprFor(undefined)} is not null` : sql`${exprFor(undefined)} is null`,
          );
          break;
        case '$regex': {
          const re = v instanceof RegExp ? v : new RegExp(String(v));
          const textExpr = jsonPath ? sql`(${col} #>> ${jsonPath})` : col;
          parts.push(
            re.flags.includes('i')
              ? sql`${textExpr} ~* ${re.source}`
              : sql`${textExpr} ~ ${re.source}`,
          );
          break;
        }
        default:
          throw new ModelValidationError(name, [
            { path, message: `operator ${op} is not supported on PostgreSQL` },
          ]);
      }
    }
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
  }

  function where(sql: any, t: any, filter: AnyRecord | undefined): any {
    if (!filter) return undefined;
    const parts: any[] = [];
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      if (k === '$and' || k === '$or') {
        const sub = (v as AnyRecord[]).map((f) => where(sql, t, f) ?? sql`true`);
        if (sub.length) parts.push(sql`(${sql.join(sub, k === '$and' ? sql` and ` : sql` or `)})`);
      } else {
        parts.push(condition(sql, t, k, v));
      }
    }
    return parts.length === 0
      ? undefined
      : parts.length === 1
        ? parts[0]
        : sql.join(parts, sql` and `);
  }

  // ── records ────────────────────────────────────────────────────────────────

  // NULL columns are dropped so records look like MongoDB's: unset fields are absent.
  const fromRow = (row: AnyRecord): AnyRecord => {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
    return out;
  };

  const validate = async (data: AnyRecord, partial: boolean) => {
    const issues: FieldIssue[] = [];
    const checkTree: SchemaTree = {};
    for (const [k, node] of Object.entries(tree)) {
      // The database assigns sequence values, so they can't be "missing" on insert.
      checkTree[k] = sequenceKeys.has(k)
        ? ({ ...node, def: { ...node.def, required: false } } as FieldNode)
        : node;
    }
    for (const key of Object.keys(data)) {
      if (!columns.has(key) && !key.includes('.'))
        issues.push({ path: key, message: 'unknown field' });
    }
    await validateTree(checkTree, data, issues, partial);
    if (issues.length) throw new ModelValidationError(name, issues);
  };

  const prepareInsert = async (input: AnyRecord): Promise<AnyRecord> => {
    const { id, ...rest } = input;
    const data = applyDefaults(tree, rest, randomUUID);
    await validate(data, false);
    const now = new Date();
    if (ts.createdAt) data[ts.createdAt] = now;
    if (ts.updatedAt) data[ts.updatedAt] = now;
    if (id !== undefined) data['id'] = id;
    for (const [k, v] of Object.entries(data)) data[k] = toDb(k, v);
    return data;
  };

  async function populate(records: AnyRecord[], paths: string | string[] | undefined) {
    if (!paths) return records;
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const ref = refs.get(path);
      if (!ref)
        throw new ModelValidationError(name, [{ path, message: 'is not a populatable ref field' }]);
      const target = getRegisteredModel(ref.model);
      if (!target) throw new Error(`[EFC] populate: model "${ref.model}" is not defined`);
      const ids = [
        ...new Set(
          records.flatMap((r) =>
            ref.many ? ((r[path] as string[]) ?? []) : r[path] ? [r[path] as string] : [],
          ),
        ),
      ];
      if (ids.length === 0) continue;
      const byId = new Map(
        (await target.find({ id: { $in: ids } } as never)).map((d) => [d.id, d]),
      );
      for (const r of records) {
        if (ref.many) r[path] = ((r[path] as string[]) ?? []).map((id) => byId.get(id) ?? id);
        else if (r[path]) r[path] = byId.get(r[path] as string) ?? r[path];
      }
    }
    return records;
  }

  const selection = (t: any, select: string[] | undefined) => {
    if (!select) return undefined;
    const out: AnyRecord = { id: t.id };
    for (const f of select) out[f] = columnFor(t, f);
    return out;
  };

  async function runFind(
    filter: AnyRecord | undefined,
    opts: FindOptions | undefined,
  ): Promise<AnyRecord[]> {
    const { t, sql } = await compile();
    const sel = selection(t, opts?.select);
    let query = (sel ? client().select(sel) : client().select()).from(t);
    const w = where(sql, t, filter);
    if (w) query = query.where(w);
    if (opts?.sort) {
      const order = Object.entries(opts.sort).map(([f, dir]) => {
        const col = columnFor(t, f);
        return dir === -1 || dir === 'desc'
          ? sql`${col} desc nulls last`
          : sql`${col} asc nulls first`;
      });
      query = query.orderBy(...order);
    }
    if (opts?.limit !== undefined) query = query.limit(opts.limit);
    if (opts?.skip !== undefined) query = query.offset(opts.skip);
    const rows = ((await query) as AnyRecord[]).map(fromRow);
    return populate(rows, opts?.populate);
  }

  // ── updates ────────────────────────────────────────────────────────────────

  async function buildSet(update: AnyRecord): Promise<AnyRecord> {
    const { t, sql } = await compile();
    const ops = update as Record<string, AnyRecord | undefined>;
    const plain: AnyRecord = {};
    for (const [k, v] of Object.entries(update)) if (!k.startsWith('$')) plain[k] = v;
    const $set = { ...(ops['$set'] ?? {}), ...plain };
    for (const op of Object.keys(update).filter((k) => k.startsWith('$'))) {
      if (!['$set', '$unset', '$inc', '$push', '$pull'].includes(op)) {
        throw new ModelValidationError(name, [
          { path: op, message: 'update operator is not supported on PostgreSQL' },
        ]);
      }
    }

    const topLevel: AnyRecord = {};
    const nested: [string, unknown][] = [];
    for (const [k, v] of Object.entries($set)) {
      if (k.includes('.')) nested.push([k, v]);
      else topLevel[k] = v;
    }
    const unset = Object.keys(ops['$unset'] ?? {});
    const toValidate: AnyRecord = { ...topLevel };
    for (const k of unset) toValidate[k] = null;
    await validate(toValidate, true);

    const set: AnyRecord = {};
    for (const [k, v] of Object.entries(topLevel)) set[k] = toDb(k, v);
    for (const k of unset) set[k] = null;
    for (const [path, v] of nested) {
      const [field, ...rest] = path.split('.');
      const col = columnFor(t, field!);
      set[field!] =
        sql`jsonb_set(coalesce(${col}, '{}'::jsonb), ${`{${rest.join(',')}}`}, ${JSON.stringify(v)}::jsonb, true)`;
    }
    for (const [k, by] of Object.entries(ops['$inc'] ?? {})) {
      set[k] = sql`coalesce(${columnFor(t, k)}, 0) + ${by as number}`;
    }
    for (const [k, v] of Object.entries(ops['$push'] ?? {})) {
      const items =
        v != null && typeof v === 'object' && '$each' in (v as AnyRecord)
          ? (v as { $each: unknown[] }).$each
          : [v];
      set[k] = sql`coalesce(${columnFor(t, k)}, '[]'::jsonb) || ${JSON.stringify(items)}::jsonb`;
    }
    for (const [k, v] of Object.entries(ops['$pull'] ?? {})) {
      const col = columnFor(t, k);
      set[k] =
        sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${col}) e where e <> ${JSON.stringify(v)}::jsonb), '[]'::jsonb)`;
    }
    if (ts.updatedAt) set[ts.updatedAt] = new Date();
    return set;
  }

  const guard = async <R>(fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn();
    } catch (err) {
      const e =
        (err as { cause?: { code?: string; detail?: string; column?: string } }).cause ??
        (err as { code?: string; detail?: string });
      if (e?.code === '23505') {
        const field = /\(([^)]+)\)=/.exec(e.detail ?? '')?.[1] ?? 'field';
        throw new HttpError(409, `${name} with this ${field.replace(/"/g, '')} already exists`);
      }
      if (e?.code === '23502')
        throw new ModelValidationError(name, [
          { path: (e as { column?: string }).column ?? '', message: 'is required' },
        ]);
      if (e?.code === '22P02')
        throw new ModelValidationError(name, [{ path: '', message: 'invalid value' }]);
      throw err;
    }
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  type Rec = T & { id: string };

  return {
    find: (filter, opts) => guard(async () => (await runFind(filter as AnyRecord, opts)) as Rec[]),

    findById: (id, opts?: ModelQueryOptions) =>
      guard(async () => {
        if (!UUID_RE.test(id)) return null; // malformed id → not found, as on MongoDB
        return ((await runFind({ id }, { ...opts, limit: 1 }))[0] as Rec | undefined) ?? null;
      }),

    findOne: (filter, opts) =>
      guard(
        async () =>
          ((await runFind(filter as AnyRecord, { ...opts, limit: 1 }))[0] as Rec | undefined) ??
          null,
      ),

    create: (data) =>
      guard(async () => {
        const { t } = await compile();
        const row = await prepareInsert(data as AnyRecord);
        const [inserted] = await client().insert(t).values(row).returning();
        return fromRow(inserted) as Rec;
      }),

    createMany: (data) =>
      guard(async () => {
        if (data.length === 0) return [];
        const { t } = await compile();
        const rows = await Promise.all(data.map((d) => prepareInsert(d as AnyRecord)));
        return ((await client().insert(t).values(rows).returning()) as AnyRecord[]).map(
          fromRow,
        ) as Rec[];
      }),

    update: (id, data) =>
      guard(async () => {
        if (!UUID_RE.test(id)) return null;
        const { t, sql } = await compile();
        const set = await buildSet(data as AnyRecord);
        const [row] = await client()
          .update(t)
          .set(set)
          .where(sql`${t.id} = ${id}`)
          .returning();
        return row ? (fromRow(row) as Rec) : null;
      }),

    updateMany: (filter, data) =>
      guard(async () => {
        const { t, sql } = await compile();
        const set = await buildSet(data as AnyRecord);
        let query = client().update(t).set(set);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query.returning({ id: t.id })) as unknown[]).length;
      }),

    delete: (id) =>
      guard(async () => {
        if (!UUID_RE.test(id)) return;
        const { t, sql } = await compile();
        await client()
          .delete(t)
          .where(sql`${t.id} = ${id}`);
      }),

    deleteMany: (filter) =>
      guard(async () => {
        const { t, sql } = await compile();
        let query = client().delete(t);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query.returning({ id: t.id })) as unknown[]).length;
      }),

    count: (filter) =>
      guard(async () => {
        const { t, sql } = await compile();
        let query = client()
          .select({ n: sql`count(*)::int` })
          .from(t);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        const [row] = (await query) as { n: number }[];
        return row?.n ?? 0;
      }),

    aggregate() {
      return Promise.reject(
        new Error(
          '[EFC] aggregate() is MongoDB-only — on PostgreSQL use db.query() or Drizzle via Model.raw()',
        ),
      );
    },

    raw: async () => (await compile()).t,

    async sync() {
      const statements: string[] = [];
      for (const { key } of sequences)
        statements.push(`CREATE SEQUENCE IF NOT EXISTS ${q(sequenceName(key))}`);

      const defs: string[] = [];
      for (const [key, kind] of columns) {
        const node = tree[key];
        let def = `${q(key)} ${SQL_TYPE[kind]}`;
        if (key === 'id') def += ' PRIMARY KEY DEFAULT gen_random_uuid()';
        if (node?.def.sequence)
          def += ` DEFAULT nextval('${sequenceName(sequenceKeys.get(key)!)}')`;
        if (node?.def.required && node.kind !== 'object' && !node.def.sequence) def += ' NOT NULL';
        if (node?.def.enum && node.kind === 'scalar')
          def += ` CHECK (${q(key)} IN (${node.def.enum.map(literal).join(', ')}))`;
        defs.push(def);
      }
      statements.push(`CREATE TABLE IF NOT EXISTS ${q(table)} (\n  ${defs.join(',\n  ')}\n)`);
      // Columns added to the model after the table exists: added nullable, never altered.
      for (const [key, kind] of columns) {
        if (key === 'id') continue;
        const seq = sequenceKeys.get(key);
        statements.push(
          `ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(key)} ${SQL_TYPE[kind]}${seq ? ` DEFAULT nextval('${sequenceName(seq)}')` : ''}`,
        );
      }
      for (const [key, node] of Object.entries(tree)) {
        if (node.def.unique)
          statements.push(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${table}_${key}_key`)} ON ${q(table)} (${q(key)})`,
          );
        else if (node.def.index)
          statements.push(
            `CREATE INDEX IF NOT EXISTS ${q(`${table}_${key}_idx`)} ON ${q(table)} (${q(key)})`,
          );
      }
      for (const idx of options.indexes ?? []) {
        const fields = Object.entries(idx.fields);
        const idxName =
          idx.name ?? `${table}_${fields.map(([f]) => f).join('_')}_${idx.unique ? 'key' : 'idx'}`;
        if (idx.expireAfterSeconds !== undefined) {
          throw new Error(`[EFC] ${name}: TTL indexes (expireAfterSeconds) are MongoDB-only`);
        }
        if (fields.some(([, d]) => d === 'text')) {
          const doc = fields.map(([f]) => `coalesce(${q(f)}::text, '')`).join(` || ' ' || `);
          statements.push(
            `CREATE INDEX IF NOT EXISTS ${q(idxName)} ON ${q(table)} USING gin (to_tsvector('simple', ${doc}))`,
          );
        } else {
          const cols = fields.map(([f, d]) => `${q(f)} ${d === -1 ? 'DESC' : 'ASC'}`).join(', ');
          statements.push(
            `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(idxName)} ON ${q(table)} (${cols})`,
          );
        }
      }

      const { sql } = await compile();
      for (const stmt of statements) await client().execute(sql.raw(stmt));
    },

    async drop() {
      const { sql } = await compile();
      await client().execute(sql.raw(`DROP TABLE IF EXISTS ${q(table)}`));
    },
  };
}
