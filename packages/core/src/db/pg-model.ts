/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle is an optional peer, loaded dynamically */
// defineModel's MongoDB-style query layer (filters with $-operators, update operators,
// populate) on PostgreSQL. The table itself — columns, sync, records, errors — is pgTable.
import type { FindOptions, ModelOptions, ModelQueryOptions } from '../types.js';
import {
  ModelValidationError,
  validateAtPath,
  nodeAt,
  type FieldIssue,
  type SchemaTree,
} from './schema.js';
import { getRegisteredModel } from './engine.js';
import { pgTable } from './pg-table.js';
import type { EngineModel } from './mongo-model.js';

export { tableNameFor } from './pg-table.js';

type AnyRecord = Record<string, unknown>;

export function pgModel<T extends object>(
  name: string,
  tree: SchemaTree,
  options: ModelOptions,
): EngineModel<T> {
  const tbl = pgTable(name, tree, options, { native: false, api: 'defineModel' });
  const { columns, ts, refs, ready, compile, client, columnFor, toDb, fromRow, validate, guard } =
    tbl;
  const kindOf = (field: string) => columns.get(field)?.kind;

  // A field the model doesn't declare behaves like a field absent from every document
  // (mongoose's strictQuery: false): equality with null / $exists: false / $ne match,
  // everything else doesn't.
  function missingField(sql: any, cond: unknown): any {
    const ops =
      cond !== null &&
      typeof cond === 'object' &&
      !Array.isArray(cond) &&
      !(cond instanceof Date) &&
      !(cond instanceof RegExp)
        ? (cond as AnyRecord)
        : { $eq: cond };
    const matches = Object.entries(ops).every(([op, v]) => {
      switch (op) {
        case '$eq':
          return v === null;
        case '$ne':
          return v !== null;
        case '$exists':
          return v === false;
        case '$in':
          return (v as unknown[]).includes(null);
        case '$nin':
          return !(v as unknown[]).includes(null);
        default:
          return false;
      }
    });
    return matches ? sql`true` : sql`false`;
  }

  function condition(sql: any, t: any, path: string, cond: unknown): any {
    const [field, ...rest] = path.split('.');
    if (!columns.has(field!)) return missingField(sql, cond);
    const col = columnFor(t, field!);
    const kind = kindOf(field!);
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
          if (v === null) parts.push(sql`${e} is not null`);
          else if (kind === 'jsonb' && !jsonPath) {
            // Array fields: "does not contain" (MongoDB semantics); objects: not equal.
            parts.push(
              Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))
                ? sql`(${col} is null or ${col} <> ${JSON.stringify(v)}::jsonb)`
                : sql`(${col} is null or not (${col} @> ${JSON.stringify([v])}::jsonb))`,
            );
          } else parts.push(sql`(${e} is null or ${e} <> ${val})`);
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
          parts.push(
            op === '$in'
              ? sql`(${inList})`
              : sql`(${kind === 'jsonb' && !jsonPath ? sql`${col} is null or ` : sql``}not (${inList}))`,
          );
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

  // `id = (first matching id)`, locked so a concurrent writer can't take the same row
  // between the lookup and the write — updateOne/deleteOne stay one statement.
  function firstMatch(sql: any, t: any, filter: AnyRecord | undefined): any {
    const w = where(sql, t, filter) ?? sql`true`;
    return sql`${t.id} = (select ${t.id} from ${t} where ${w} limit 1 for update)`;
  }

  // ── records ────────────────────────────────────────────────────────────────

  const prepareInsert = tbl.prepareInsert;

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
      const byId = new Map((await target.findByIds(ids)).map((d) => [d['id'], d]));
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
    for (const f of select) if (columns.has(f)) out[f] = columnFor(t, f);
    return out;
  };

  async function runFind(
    filter: AnyRecord | undefined,
    opts: FindOptions | undefined,
  ): Promise<AnyRecord[]> {
    const { t, sql } = await ready();
    const sel = selection(t, opts?.select);
    let query = (sel ? client().select(sel) : client().select()).from(t);
    const w = where(sql, t, filter);
    if (w) query = query.where(w);
    if (opts?.sort) {
      const order = Object.entries(opts.sort)
        .filter(([f]) => columns.has(f))
        .map(([f, dir]) => {
          const col = columnFor(t, f);
          return dir === -1 || dir === 'desc'
            ? sql`${col} desc nulls last`
            : sql`${col} asc nulls first`;
        });
      if (order.length) query = query.orderBy(...order);
    }
    if (opts?.limit !== undefined) query = query.limit(opts.limit);
    if (opts?.skip !== undefined) query = query.offset(opts.skip);
    const rows = ((await query) as AnyRecord[]).map(fromRow);
    return populate(rows, opts?.populate);
  }

  // ── updates ────────────────────────────────────────────────────────────────

  // Drops undeclared fields from an update, at the top level and inside operators —
  // including dotted paths the nested schema doesn't have (mongoose's strict mode).
  const strictUpdate = (update: AnyRecord): AnyRecord => {
    const declared = (path: string) =>
      columns.has(path.split('.')[0]!) &&
      (!path.includes('.') || nodeAt(tree, path.split('.')) !== undefined);
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(update)) {
      if (k.startsWith('$') && v !== null && typeof v === 'object') {
        out[k] = Object.fromEntries(Object.entries(v as AnyRecord).filter(([p]) => declared(p)));
      } else if (k.startsWith('$') || declared(k)) out[k] = v;
    }
    return out;
  };

  async function buildSet(input: AnyRecord): Promise<AnyRecord> {
    const { t, sql } = await compile();
    const update = strictUpdate(input);
    const ops = update as Record<string, AnyRecord | undefined>;
    for (const op of Object.keys(update).filter((k) => k.startsWith('$'))) {
      if (!['$set', '$unset', '$inc', '$push', '$pull'].includes(op)) {
        throw new ModelValidationError(name, [
          { path: op, message: 'update operator is not supported on PostgreSQL' },
        ]);
      }
    }
    const plain: AnyRecord = {};
    for (const [k, v] of Object.entries(update)) if (!k.startsWith('$')) plain[k] = v;
    const $set: AnyRecord = { ...(ops['$set'] ?? {}), ...plain };

    // Validate: top-level fields with the partial-update rules, dotted paths against the
    // schema node they target (MongoDB's runValidators covers both on that engine).
    const issues: FieldIssue[] = [];
    const topLevel: AnyRecord = {};
    for (const [k, v] of Object.entries($set)) if (!k.includes('.')) topLevel[k] = v;
    for (const k of Object.keys(ops['$unset'] ?? {})) if (!k.includes('.')) topLevel[k] = null;
    for (const [k, v] of Object.entries($set))
      if (k.includes('.')) await validateAtPath(tree, k, v, issues);
    for (const k of Object.keys(ops['$unset'] ?? {})) {
      if (k.includes('.')) await validateAtPath(tree, k, null, issues);
    }
    for (const [k, by] of Object.entries(ops['$inc'] ?? {})) {
      if (typeof by !== 'number') issues.push({ path: k, message: '$inc needs a number' });
      const node = k.includes('.') ? nodeAt(tree, k.split('.')) : tree[k];
      if (node && !(node.kind === 'scalar' && node.type === 'number') && node.kind !== 'json') {
        issues.push({ path: k, message: '$inc only applies to number fields' });
      }
    }
    if (issues.length) throw new ModelValidationError(name, issues);
    await validate(topLevel, true);

    // Each touched column gets one expression; dotted operations on the same jsonb column
    // compose onto it in order instead of overwriting each other.
    const set: AnyRecord = {};
    const nested = new Map<string, unknown>();
    const touchedTop = new Set<string>();
    const acc = (field: string) => (nested.get(field) ?? columnFor(t, field)) as unknown;
    const conflict = (path: string) => {
      throw new ModelValidationError(name, [{ path, message: 'conflicting update paths' }]);
    };
    const top = (field: string, value: unknown) => {
      if (touchedTop.has(field) || nested.has(field)) conflict(field);
      touchedTop.add(field);
      set[field] = value;
    };
    // jsonb_set only creates the last key of a path; build missing parents first, as MongoDB does.
    const withParents = (base: unknown, parts: string[]) => {
      let expr = sql`coalesce(${base}, '{}'::jsonb)`;
      for (let i = 1; i < parts.length; i++) {
        const prefix = `{${parts.slice(0, i).join(',')}}`;
        expr = sql`jsonb_set(${expr}, ${prefix}, coalesce(${expr} #> ${prefix}, '{}'::jsonb), true)`;
      }
      return expr;
    };
    const dotted = (path: string, apply: (base: unknown, jsonPath: string) => unknown) => {
      const [field, ...rest] = path.split('.');
      if (touchedTop.has(field!)) conflict(path);
      columnFor(t, field!);
      const base = withParents(acc(field!), rest);
      nested.set(field!, apply(base, `{${rest.join(',')}}`));
    };
    const items = (v: unknown) =>
      JSON.stringify(
        v != null && typeof v === 'object' && '$each' in (v as AnyRecord)
          ? (v as { $each: unknown[] }).$each
          : [v],
      );

    for (const [k, v] of Object.entries($set)) {
      if (k.includes('.'))
        dotted(k, (b, p) => sql`jsonb_set(${b}, ${p}, ${JSON.stringify(v)}::jsonb, true)`);
      else top(k, toDb(k, v));
    }
    for (const k of Object.keys(ops['$unset'] ?? {})) {
      if (k.includes('.')) dotted(k, (b, p) => sql`(${b} #- ${p})`);
      else top(k, null);
    }
    for (const [k, by] of Object.entries(ops['$inc'] ?? {})) {
      if (k.includes('.')) {
        dotted(
          k,
          (b, p) =>
            sql`jsonb_set(${b}, ${p}, to_jsonb(coalesce((${b} #>> ${p})::double precision, 0) + ${by as number}), true)`,
        );
      } else top(k, sql`coalesce(${columnFor(t, k)}, 0) + ${by as number}`);
    }
    for (const [k, v] of Object.entries(ops['$push'] ?? {})) {
      if (k.includes('.')) {
        dotted(
          k,
          (b, p) =>
            sql`jsonb_set(${b}, ${p}, coalesce(${b} #> ${p}, '[]'::jsonb) || ${items(v)}::jsonb, true)`,
        );
      } else top(k, sql`coalesce(${columnFor(t, k)}, '[]'::jsonb) || ${items(v)}::jsonb`);
    }
    for (const [k, v] of Object.entries(ops['$pull'] ?? {})) {
      const without = (arr: unknown) =>
        sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${arr}) e where e <> ${JSON.stringify(v)}::jsonb), '[]'::jsonb)`;
      if (k.includes('.'))
        dotted(k, (b, p) => sql`jsonb_set(${b}, ${p}, ${without(sql`(${b} #> ${p})`)}, true)`);
      else top(k, without(columnFor(t, k)));
    }
    for (const [field, expr] of nested) set[field] = expr;
    if (ts.updatedAt) set[ts.updatedAt] = new Date();
    return set;
  }

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

    exists: (filter) =>
      guard(async () => {
        const { t, sql } = await ready();
        let query = client()
          .select({ one: sql`1` })
          .from(t);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query.limit(1)) as unknown[]).length > 0;
      }),

    distinct: (field, filter) =>
      guard(async () => {
        const { t, sql } = await ready();
        if (!columns.has(field)) return [];
        let query = client()
          .selectDistinct({ v: columnFor(t, field) })
          .from(t);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query) as { v: unknown }[]).map((r) => r.v);
      }),

    create: (data) =>
      guard(async () => {
        const { t } = await ready();
        const row = await prepareInsert(data as AnyRecord);
        const [inserted] = await client().insert(t).values(row).returning();
        return fromRow(inserted) as Rec;
      }),

    createMany: (data) =>
      guard(async () => {
        if (data.length === 0) return [];
        const { t } = await ready();
        const rows = await Promise.all(data.map((d) => prepareInsert(d as AnyRecord)));
        return ((await client().insert(t).values(rows).returning()) as AnyRecord[]).map(
          fromRow,
        ) as Rec[];
      }),

    update: (id, data) =>
      guard(async () => {
        if (!UUID_RE.test(id)) return null;
        const { t, sql } = await ready();
        const set = await buildSet(data as AnyRecord);
        const [row] = await client()
          .update(t)
          .set(set)
          .where(sql`${t.id} = ${id}`)
          .returning();
        return row ? (fromRow(row) as Rec) : null;
      }),

    updateOne: (filter, data) =>
      guard(async () => {
        const { t, sql } = await ready();
        const set = await buildSet(data as AnyRecord);
        if (Object.keys(set).length === 0) {
          return ((await runFind(filter as AnyRecord, { limit: 1 }))[0] as Rec | undefined) ?? null;
        }
        const [row] = await client()
          .update(t)
          .set(set)
          .where(firstMatch(sql, t, filter as AnyRecord))
          .returning();
        return row ? (fromRow(row) as Rec) : null;
      }),

    updateMany: (filter, data) =>
      guard(async () => {
        const { t, sql } = await ready();
        const set = await buildSet(data as AnyRecord);
        let query = client().update(t).set(set);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query.returning({ id: t.id })) as unknown[]).length;
      }),

    delete: (id) =>
      guard(async () => {
        if (!UUID_RE.test(id)) return;
        const { t, sql } = await ready();
        await client()
          .delete(t)
          .where(sql`${t.id} = ${id}`);
      }),

    deleteOne: (filter) =>
      guard(async () => {
        const { t, sql } = await ready();
        const [row] = await client()
          .delete(t)
          .where(firstMatch(sql, t, filter as AnyRecord))
          .returning();
        return row ? (fromRow(row) as Rec) : null;
      }),

    deleteMany: (filter) =>
      guard(async () => {
        const { t, sql } = await ready();
        let query = client().delete(t);
        const w = where(sql, t, filter as AnyRecord);
        if (w) query = query.where(w);
        return ((await query.returning({ id: t.id })) as unknown[]).length;
      }),

    count: (filter) =>
      guard(async () => {
        const { t, sql } = await ready();
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

    sync: (opts?: { dryRun?: boolean }) => tbl.reconcile(opts?.dryRun ?? false),

    plan: (opts) => tbl.plan(opts),

    drop: () => tbl.drop(),
  };
}
