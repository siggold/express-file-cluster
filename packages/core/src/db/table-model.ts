/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle is an optional peer, loaded dynamically */
// defineTable: the PostgreSQL-native model API, in Prisma's vocabulary —
// findMany({ where, orderBy, take, skip, cursor, select, distinct }), findUnique, upsert
// (INSERT … ON CONFLICT), groupBy, aggregate. Every query is one parameterised statement,
// compiled with Drizzle's `sql` against the shared pgTable (pg-table.ts).
import { randomUUID } from 'node:crypto';
import type { TableOptions, TableSchema } from '../types.js';
import type { TableModel } from '../table-types.js';
import { HttpError, isHttpError } from '../errors.js';
import { ModelValidationError, normalizeSchema, type FieldIssue } from './schema.js';
import { getDbEngine, getRegisteredModel, registerModel } from './engine.js';
import { pgTable, q, type ColumnSpec, type JoinSpec, type PgTable } from './pg-table.js';
import { transaction } from './transaction.js';
import { traceOps } from './query-log.js';

type AnyRecord = Record<string, any>;
type Sql = any;

const AGGREGATES = ['_count', '_sum', '_avg', '_min', '_max'] as const;
type Aggregate = (typeof AGGREGATES)[number];
const NUMERIC_KINDS = new Set(['double', 'integer', 'bigint', 'numeric']);

const isPlainObject = (v: unknown): v is AnyRecord =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp) &&
  typeof v !== 'bigint';

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A change to a many-to-many field: replace its links, append to them, or remove some. */
interface JoinOp {
  field: string;
  mode: 'set' | 'push' | 'pull';
  items: unknown[];
}

const relAlias = (field: string) => `efc_rel_${field}`;
const incAlias = (name: string) => `efc_inc_${name}`;
// Nested write operations, per kind of relation.
const ONE_OPS = new Set(['connect', 'create', 'connectOrCreate', 'disconnect']);
const JOIN_OPS = new Set([
  'connect',
  'create',
  'connectOrCreate',
  'disconnect',
  'set',
  'push',
  'pull',
]);
const BACK_ONE_OPS = new Set(['connect', 'create', 'disconnect', 'delete']);
const BACK_MANY_OPS = new Set(['connect', 'create', 'disconnect', 'set', 'delete', 'deleteMany']);
const idJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? String(v) : v);
// Relation filters can nest; every subquery gets its own alias.
let aliasSeq = 0;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
// jsonb_build_object takes at most 100 arguments: build wide records in chunks.
const JSON_PAIRS_PER_CALL = 50;

/**
 * Something `include` can load: a model's own `ref` field (scalar → one record,
 * many-to-many → a list) or a back-relation from `options.relations`.
 */
type Relation =
  | { name: string; kind: 'one'; via: 'fk'; target: string; column: string }
  | { name: string; kind: 'many'; via: 'join'; target: string; join: JoinSpec }
  | { name: string; kind: 'one' | 'many'; via: 'back'; target: string; foreignKey: string };
// Ids go to PostgreSQL as text (bigints included) and are cast there.
const idText = (v: unknown) => (v == null ? v : String(v));
const dedupe = (items: unknown[]) => {
  const seen = new Set<string>();
  return items.filter((v) => {
    const k = String(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** The runtime behind a `defineTable` model, compiled on first use. */
class TableRuntime {
  readonly tbl: PgTable;
  private readonly uniqueSets: string[][];
  /** Many-to-many fields as list columns, so filters and projections treat them alike. */
  private readonly joinSpecs = new Map<string, ColumnSpec>();

  constructor(
    readonly name: string,
    schema: TableSchema,
    readonly options: TableOptions,
  ) {
    const tree = normalizeSchema(schema, 'table', name);
    this.tbl = pgTable(name, tree, options, { native: true, api: 'defineTable' });
    this.uniqueSets = [['id']];
    for (const spec of this.tbl.columns.values()) {
      if (spec.node?.def.unique) this.uniqueSets.push([spec.field]);
    }
    for (const idx of options.indexes ?? []) {
      if (idx.unique) this.uniqueSets.push(Object.keys(idx.fields));
    }
    for (const j of this.tbl.joins.values()) {
      this.joinSpecs.set(j.field, {
        field: j.field,
        column: j.field,
        kind: 'array',
        item: j.item,
        ddl: j.ddl,
        formatted: j.ddl,
        node: j.node,
      });
    }
  }

  private fail(path: string, message: string): never {
    throw new ModelValidationError(this.name, [{ path, message }]);
  }

  private spec(field: string): ColumnSpec | undefined {
    return this.tbl.columns.get(field) ?? this.joinSpecs.get(field);
  }

  private join(field: string): JoinSpec | undefined {
    return this.tbl.joins.get(field);
  }

  /** A many-to-many field's ids, in order, for the row `owner` (a table name or alias). */
  private joinExpr(sql: Sql, join: JoinSpec, owner: string): Sql {
    return sql.raw(
      `coalesce((select array_agg(efc_j.ref_id order by efc_j.position) from ${q(join.table)} efc_j where efc_j.owner_id = ${owner}.${q('id')}), '{}'::${join.ddl})`,
    );
  }

  private col(sql: Sql, field: string, alias?: string): Sql {
    const join = this.join(field);
    if (join) return this.joinExpr(sql, join, alias ?? q(this.tbl.table));
    const spec = this.spec(field)!;
    return sql.raw(alias ? `${alias}.${q(spec.column)}` : q(spec.column));
  }

  /** SELECT items for the many-to-many fields among `fields`, as text arrays. */
  private joinColumns(sql: Sql, fields: string[], owner?: string): Sql[] {
    return fields
      .filter((f) => this.join(f))
      .map((f) => sql`${this.col(sql, f, owner)}::text[] as ${sql.raw(q(relAlias(f)))}`);
  }

  /** `col` for SELECT lists: many-to-many fields come back as text arrays under an alias. */
  private selectCols(sql: Sql, fields: string[], owner?: string): Sql {
    return sql.join(
      [
        ...fields.filter((f) => !this.join(f)).map((f) => this.col(sql, f, owner)),
        ...this.joinColumns(sql, fields, owner),
      ],
      sql`, `,
    );
  }

  /** Ids as stored text → the record's type (string uuids, numbers, bigints). */
  private joinValues(join: JoinSpec, items: unknown[]): unknown[] {
    return items.map((v) =>
      v == null
        ? v
        : join.item === 'bigint'
          ? BigInt(String(v))
          : join.item === 'integer'
            ? Number(v)
            : String(v),
    );
  }

  /** A value for `field`, encoded the way its Drizzle column does it. */
  private val(sql: Sql, t: any, field: string, value: unknown): Sql {
    const join = this.join(field);
    if (join) {
      const items = Array.isArray(value) ? value.map(idText) : value;
      return sql`${sql.param(items)}::${sql.raw(join.ddl)}`;
    }
    return sql`${sql.param(this.tbl.toDb(field, value), t[field])}`;
  }

  /** One array element / scalar compared against an array column's items. */
  private itemVal(sql: Sql, field: string, value: unknown): Sql {
    const spec = this.spec(field)!;
    const [v] = (this.tbl.toDb(field, [value]) as unknown[]) ?? [value];
    return sql`${sql.param(spec.item === 'bigint' ? String(v) : v)}`;
  }

  private fromRaw(t: any, row: AnyRecord): AnyRecord {
    const keyed: AnyRecord = {};
    for (const join of this.tbl.joins.values()) {
      const v = row[relAlias(join.field)];
      if (Array.isArray(v)) keyed[join.field] = this.joinValues(join, v);
    }
    for (const spec of this.tbl.columns.values()) {
      if (!(spec.column in row)) continue;
      const v = row[spec.column];
      keyed[spec.field] = v == null ? v : t[spec.field].mapFromDriverValue(v);
    }
    return this.tbl.fromRow(keyed);
  }

  // ── where ──────────────────────────────────────────────────────────────────

  /** WHERE for `where`; `alias` qualifies the columns (subqueries, e.g. inside `include`). */
  where(sql: Sql, t: any, where: AnyRecord | undefined, alias?: string): Sql | undefined {
    if (!where) return undefined;
    const parts: Sql[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        const list = (Array.isArray(value) ? value : [value]) as AnyRecord[];
        const subs = list.map((w) => this.where(sql, t, w, alias) ?? sql`true`);
        if (key === 'AND')
          parts.push(subs.length ? sql`(${sql.join(subs, sql` and `)})` : sql`true`);
        else if (key === 'OR')
          parts.push(subs.length ? sql`(${sql.join(subs, sql` or `)})` : sql`false`);
        else parts.push(subs.length ? sql`not (${sql.join(subs, sql` or `)})` : sql`true`);
        continue;
      }
      const rel = this.relationFilterOf(key, value);
      if (rel) {
        parts.push(this.relationFilter(sql, rel, value as AnyRecord, alias));
        continue;
      }
      const spec = this.spec(key);
      if (!spec) {
        // Undeclared: absent from every row, as on defineModel.
        const isNull = value === null || (isPlainObject(value) && value['equals'] === null);
        parts.push(isNull ? sql`true` : sql`false`);
        continue;
      }
      parts.push(this.fieldFilter(sql, t, spec, value, alias));
    }
    if (parts.length === 0) return undefined;
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
  }

  private fieldFilter(sql: Sql, t: any, spec: ColumnSpec, filter: unknown, alias?: string): Sql {
    const c = this.col(sql, spec.field, alias);
    if (filter === null) return sql`${c} is null`;
    if (spec.kind === 'jsonb') return this.jsonFilter(sql, t, spec, filter, alias);
    if (spec.kind === 'array') return this.listFilter(sql, t, spec, filter, alias);
    if (!isPlainObject(filter)) return sql`${c} = ${this.val(sql, t, spec.field, filter)}`;

    const insensitive = filter['mode'] === 'insensitive';
    const text = spec.kind === 'enum' || insensitive ? sql`${c}::text` : c;
    const parts: Sql[] = [];
    for (const [op, v] of Object.entries(filter)) {
      if (v === undefined || op === 'mode') continue;
      const val = () => this.val(sql, t, spec.field, v);
      const eq = (x: unknown) =>
        insensitive && typeof x === 'string'
          ? sql`lower(${text}) = lower(${sql.param(x)})`
          : sql`${c} = ${this.val(sql, t, spec.field, x)}`;
      switch (op) {
        case 'equals':
          parts.push(v === null ? sql`${c} is null` : eq(v));
          break;
        case 'not':
          parts.push(
            v === null
              ? sql`${c} is not null`
              : isPlainObject(v)
                ? sql`not (${this.fieldFilter(sql, t, spec, { ...v, ...(insensitive && { mode: 'insensitive' }) }, alias)})`
                : sql`not (${eq(v)})`,
          );
          break;
        case 'in':
        case 'notIn': {
          const list = v as unknown[];
          if (list.length === 0) {
            parts.push(op === 'in' ? sql`false` : sql`true`);
            break;
          }
          const items = sql.join(
            list.map((x) => this.val(sql, t, spec.field, x)),
            sql`, `,
          );
          parts.push(op === 'in' ? sql`${c} in (${items})` : sql`${c} not in (${items})`);
          break;
        }
        case 'lt':
          parts.push(sql`${c} < ${val()}`);
          break;
        case 'lte':
          parts.push(sql`${c} <= ${val()}`);
          break;
        case 'gt':
          parts.push(sql`${c} > ${val()}`);
          break;
        case 'gte':
          parts.push(sql`${c} >= ${val()}`);
          break;
        case 'contains':
        case 'startsWith':
        case 'endsWith': {
          const s = likeEscape(String(v));
          const pattern = op === 'contains' ? `%${s}%` : op === 'startsWith' ? `${s}%` : `%${s}`;
          parts.push(
            insensitive
              ? sql`${text} ilike ${sql.param(pattern)}`
              : sql`${text} like ${sql.param(pattern)}`,
          );
          break;
        }
        default:
          this.fail(spec.field, `unknown filter "${op}"`);
      }
    }
    return parts.length === 0
      ? sql`true`
      : parts.length === 1
        ? parts[0]
        : sql`(${sql.join(parts, sql` and `)})`;
  }

  /** Scalar lists (native arrays): has, hasEvery, hasSome, isEmpty, equals. */
  private listFilter(sql: Sql, t: any, spec: ColumnSpec, filter: unknown, alias?: string): Sql {
    const c = this.col(sql, spec.field, alias);
    if (!isPlainObject(filter)) return sql`${c} = ${this.val(sql, t, spec.field, filter)}`;
    const parts: Sql[] = [];
    for (const [op, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      switch (op) {
        case 'equals':
          parts.push(
            v === null ? sql`${c} is null` : sql`${c} = ${this.val(sql, t, spec.field, v)}`,
          );
          break;
        case 'has':
          parts.push(
            v === null ? sql`false` : sql`${this.itemVal(sql, spec.field, v)} = any(${c})`,
          );
          break;
        case 'hasEvery':
          parts.push(sql`${c} @> ${this.val(sql, t, spec.field, v)}`);
          break;
        case 'hasSome':
          parts.push(sql`${c} && ${this.val(sql, t, spec.field, v)}`);
          break;
        case 'isEmpty':
          parts.push(v ? sql`cardinality(${c}) = 0` : sql`cardinality(${c}) > 0`);
          break;
        default:
          this.fail(spec.field, `unknown list filter "${op}"`);
      }
    }
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
  }

  /** jsonb fields (embedded objects / arrays of objects / json): Prisma's JSON filters. */
  private jsonFilter(sql: Sql, t: any, spec: ColumnSpec, filter: unknown, alias?: string): Sql {
    const c = this.col(sql, spec.field, alias);
    const json = (v: unknown) => sql`${sql.param(JSON.stringify(v))}::jsonb`;
    if (!isPlainObject(filter) || !Object.keys(filter).some((k) => JSON_OPS.has(k))) {
      return sql`${c} = ${json(filter)}`;
    }
    const path = filter['path'] as string[] | string | undefined;
    const segs = path === undefined ? [] : Array.isArray(path) ? path : String(path).split('.');
    const target = segs.length ? sql`(${c} #> ${sql.param(`{${segs.join(',')}}`)})` : c;
    const textTarget = segs.length
      ? sql`(${c} #>> ${sql.param(`{${segs.join(',')}}`)})`
      : sql`(${c} #>> '{}')`;
    const parts: Sql[] = [];
    for (const [op, v] of Object.entries(filter)) {
      if (v === undefined || op === 'path' || op === 'mode') continue;
      switch (op) {
        case 'equals':
          parts.push(v === null ? sql`${target} is null` : sql`${target} = ${json(v)}`);
          break;
        case 'not':
          parts.push(
            v === null ? sql`${target} is not null` : sql`${target} is distinct from ${json(v)}`,
          );
          break;
        case 'string_contains':
        case 'string_starts_with':
        case 'string_ends_with': {
          const s = likeEscape(String(v));
          const p =
            op === 'string_contains' ? `%${s}%` : op === 'string_starts_with' ? `${s}%` : `%${s}`;
          parts.push(
            filter['mode'] === 'insensitive'
              ? sql`${textTarget} ilike ${sql.param(p)}`
              : sql`${textTarget} like ${sql.param(p)}`,
          );
          break;
        }
        case 'array_contains':
          parts.push(sql`${target} @> ${json(Array.isArray(v) ? v : [v])}`);
          break;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          const opSql = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
          parts.push(
            typeof v === 'number'
              ? sql`(${textTarget})::double precision ${sql.raw(opSql)} ${sql.param(v)}`
              : sql`${textTarget} ${sql.raw(opSql)} ${sql.param(v instanceof Date ? v.toISOString() : String(v))}`,
          );
          break;
        }
        default:
          this.fail(spec.field, `unknown JSON filter "${op}"`);
      }
    }
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
  }

  // ── ordering, projection, pagination ───────────────────────────────────────

  private orderList(
    orderBy: unknown,
  ): { field: string; desc: boolean; nulls?: 'first' | 'last' }[] {
    const list = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
    const out: { field: string; desc: boolean; nulls?: 'first' | 'last' }[] = [];
    for (const entry of list as AnyRecord[]) {
      for (const [field, dir] of Object.entries(entry)) {
        if (dir === undefined || !this.spec(field)) continue; // undeclared: ignored
        if (this.join(field)) this.fail(`orderBy.${field}`, "can't order by a many-to-many field");
        if (isPlainObject(dir))
          out.push({ field, desc: dir['sort'] === 'desc', nulls: dir['nulls'] });
        else out.push({ field, desc: dir === 'desc' });
      }
    }
    return out;
  }

  private orderSql(
    sql: Sql,
    list: { field: string; desc: boolean; nulls?: 'first' | 'last' }[],
    alias?: string,
  ): Sql {
    return sql.join(
      list.map(
        (o) =>
          sql`${this.col(sql, o.field, alias)} ${sql.raw(o.desc ? 'desc' : 'asc')}${o.nulls ? sql.raw(` nulls ${o.nulls}`) : sql``}`,
      ),
      sql`, `,
    );
  }

  /** The fields a result keeps, from `select` / `omit`. */
  private projection(args: AnyRecord): string[] {
    const all = [...this.tbl.columns.keys(), ...this.tbl.joins.keys()];
    if (args['select'] && args['omit']) this.fail('select', 'use either select or omit, not both');
    if (args['select']) {
      const keep = Object.entries(args['select'] as AnyRecord)
        .filter(([f, on]) => on && this.spec(f))
        .map(([f]) => f);
      return keep;
    }
    if (args['omit']) {
      const drop = new Set(
        Object.entries(args['omit'] as AnyRecord)
          .filter(([, on]) => on)
          .map(([f]) => f),
      );
      return all.filter((f) => !drop.has(f));
    }
    return all;
  }

  private project(record: AnyRecord, fields: string[]): AnyRecord {
    const out: AnyRecord = {};
    for (const f of fields) if (record[f] !== undefined) out[f] = record[f];
    return out;
  }

  /** Checks `where` names a unique key (id, a unique field, or a compound unique index). */
  uniqueKey(where: AnyRecord | undefined, op: string): string[] {
    const plain = (f: string) =>
      where?.[f] !== undefined && where[f] !== null && !isPlainObject(where[f]);
    const key = this.uniqueSets.find((set) => set.every(plain));
    if (!key) {
      this.fail(
        'where',
        `${op} needs a unique field in where: ${this.uniqueSets.map((s) => s.join(' + ')).join(', ')}`,
      );
    }
    return key;
  }

  /** WHERE for findMany-style reads: filter, plus the cursor's keyset condition. */
  private readWhere(
    sql: Sql,
    t: any,
    args: AnyRecord,
    order: ReturnType<TableRuntime['orderList']>,
  ): Sql {
    const parts: Sql[] = [];
    const w = this.where(sql, t, args['where']);
    if (w) parts.push(w);
    if (args['cursor']) {
      this.uniqueKey(args['cursor'], 'cursor');
      const cw = this.where(sql, t, args['cursor'])!;
      const at = (field: string) =>
        sql`(select ${this.col(sql, field)} from ${sql.raw(q(this.tbl.table))} where ${cw})`;
      // Rows at or after the cursor in `order`: a keyset comparison expanded per column so
      // mixed directions work, NULL-aware (PostgreSQL puts NULLs last ascending, first
      // descending, unless `nulls` says otherwise). The cursor row itself is included
      // (skip: 1 drops it).
      const ors: Sql[] = [];
      const same = (o: { field: string }) =>
        sql`${this.col(sql, o.field)} is not distinct from ${at(o.field)}`;
      for (let i = 0; i < order.length; i++) {
        const o = order[i]!;
        const c = this.col(sql, o.field);
        const v = at(o.field);
        const nullsFirst = o.nulls ? o.nulls === 'first' : o.desc;
        const after = sql`((${v} is null and ${nullsFirst ? sql`${c} is not null` : sql`false`}) or (${v} is not null and (${c} ${sql.raw(o.desc ? '<' : '>')} ${v}${nullsFirst ? sql`` : sql` or ${c} is null`})))`;
        const eqs = order.slice(0, i).map(same);
        ors.push(eqs.length ? sql`(${sql.join([...eqs, after], sql` and `)})` : after);
      }
      ors.push(sql`(${sql.join(order.map(same), sql` and `)})`);
      parts.push(sql`exists (select 1 from ${sql.raw(q(this.tbl.table))} where ${cw})`);
      parts.push(sql`(${sql.join(ors, sql` or `)})`);
    }
    return parts.length ? sql.join(parts, sql` and `) : sql`true`;
  }

  /** SELECT for a findMany-style read, and whether the rows come back reversed. */
  private readQuery(
    sql: Sql,
    t: any,
    args: AnyRecord,
    columnsSql: Sql,
  ): { query: Sql; reversed: boolean } {
    const take = args['take'] as number | undefined;
    const reversed = take !== undefined && take < 0;
    let order = this.orderList(args['orderBy']);
    // Pages need a total order, so every page agrees on where ties go: break them by id.
    const paged = args['cursor'] || take !== undefined || args['skip'];
    if (paged && !order.some((o) => o.field === 'id')) {
      order = [...order, { field: 'id', desc: false }];
    }
    if (reversed) {
      order = order.map((o) => ({
        ...o,
        desc: !o.desc,
        ...(o.nulls && { nulls: o.nulls === 'first' ? ('last' as const) : ('first' as const) }),
      }));
    }
    const limit = take === undefined ? sql`` : sql` limit ${sql.param(Math.abs(take))}`;
    const offset = args['skip'] ? sql` offset ${sql.param(args['skip'])}` : sql``;
    const orderBy = order.length ? sql` order by ${this.orderSql(sql, order)}` : sql``;
    const where = this.readWhere(sql, t, args, order);
    const from = sql.raw(q(this.tbl.table));

    const distinct = (args['distinct'] as string[] | undefined)?.filter((f) => this.spec(f));
    if (distinct?.length) {
      const dcols = sql.join(
        distinct.map((f) => this.col(sql, f)),
        sql`, `,
      );
      const inner = sql`select distinct on (${dcols}) * from ${from} where ${where} order by ${dcols}${order.length ? sql`, ${this.orderSql(sql, order)}` : sql``}`;
      return {
        query: sql`select ${columnsSql} from (${inner}) as efc_distinct${orderBy}${limit}${offset}`,
        reversed,
      };
    }
    return {
      query: sql`select ${columnsSql} from ${from} where ${where}${orderBy}${limit}${offset}`,
      reversed,
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async findMany(args: AnyRecord = {}): Promise<AnyRecord[]> {
    const { t, sql } = await this.ready(args['where'], args['cursor']);
    return this.tbl.guard(async () => {
      const fields = this.projection(args);
      // A distinct read selects from a derived table, not the table itself.
      const distinct = (args['distinct'] as string[] | undefined)?.some((f) => this.spec(f));
      const cols = this.selectCols(
        sql,
        [...new Set(['id', ...fields])],
        distinct ? 'efc_distinct' : undefined,
      );
      const include = this.includeArg(args);
      const included = include
        ? await this.includeColumns(sql, include, distinct ? 'efc_distinct' : q(this.tbl.table), 1)
        : [];
      const { query, reversed } = this.readQuery(
        sql,
        t,
        args,
        included.length ? sql`${cols}, ${sql.join(included, sql`, `)}` : cols,
      );
      const rows = ((await this.tbl.client().execute(query)).rows as AnyRecord[]).map((r) => {
        const record = this.project(this.fromRaw(t, r), fields);
        if (include) this.attachIncludes(record, r, include);
        return record;
      });
      return reversed ? rows.reverse() : rows;
    });
  }

  // ── include ────────────────────────────────────────────────────────────────

  private relationCache?: Map<string, Relation>;

  /** What `include` can name on this model. */
  relations(): Map<string, Relation> {
    if (this.relationCache) return this.relationCache;
    const out = new Map<string, Relation>();
    for (const spec of this.tbl.columns.values()) {
      const ref = spec.node?.kind === 'scalar' ? spec.node.def.ref : undefined;
      if (ref)
        out.set(spec.field, {
          name: spec.field,
          kind: 'one',
          via: 'fk',
          target: ref,
          column: spec.column,
        });
    }
    for (const join of this.tbl.joins.values()) {
      out.set(join.field, {
        name: join.field,
        kind: 'many',
        via: 'join',
        target: join.target,
        join,
      });
    }
    for (const [name, def] of Object.entries(this.options.relations ?? {})) {
      out.set(name, {
        name,
        kind: def.hasOne ? 'one' : 'many',
        via: 'back',
        target: (def.hasOne ?? def.hasMany)!,
        foreignKey: def.foreignKey,
      });
    }
    return (this.relationCache = out);
  }

  private relation(name: string): Relation {
    const rel = this.relations().get(name);
    if (!rel) {
      const known = [...this.relations().keys()];
      this.fail(
        `include.${name}`,
        known.length
          ? `not a relation of ${this.name} (relations: ${known.join(', ')})`
          : `${this.name} has no relations — add a ref field or options.relations`,
      );
    }
    return rel;
  }

  private includeArg(args: AnyRecord): AnyRecord | undefined {
    const include = args['include'];
    if (include === undefined) return undefined;
    if (!isPlainObject(include)) this.fail('include', 'must be an object');
    return Object.values(include).some(Boolean) ? include : undefined;
  }

  /** SELECT items loading `include` for rows of this table aliased `owner`. */
  private async includeColumns(
    sql: Sql,
    include: AnyRecord,
    owner: string,
    depth: number,
  ): Promise<Sql[]> {
    const out: Sql[] = [];
    for (const [name, arg] of Object.entries(include)) {
      if (!arg) continue;
      const expr = await this.relationExpr(sql, this.relation(name), relArgs(arg), owner, depth);
      out.push(sql`${expr} as ${sql.raw(q(incAlias(name)))}`);
    }
    return out;
  }

  /**
   * One relation as a correlated subquery yielding jsonb: a record (or null) for one, an
   * array of records for many. Nested includes nest inside it, so a read is one statement.
   */
  private async relationExpr(
    sql: Sql,
    rel: Relation,
    args: AnyRecord,
    owner: string,
    depth: number,
  ): Promise<Sql> {
    const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
    const { t } = await T.ready(args['where']);
    const a = `efc_r${depth}`;
    const obj = await T.jsonRecord(sql, t, args, a, depth + 1);
    const { from, cond, defaultOrder } = this.relationSource(rel, owner, a, `efc_j${depth}`);
    if (rel.via === 'fk') return sql`(select ${obj} from ${sql.raw(from)} where ${sql.raw(cond)})`;
    if (rel.kind === 'one') {
      return sql`(select ${obj} from ${sql.raw(from)} where ${sql.raw(cond)} limit 1)`;
    }

    const where = T.where(sql, t, args['where'], a);
    const order = args['orderBy']
      ? T.orderSql(sql, T.orderList(args['orderBy']), a)
      : sql.raw(defaultOrder);
    const take = args['take'] as number | undefined;
    if (take !== undefined && (!Number.isInteger(take) || take < 0)) {
      this.fail(`include.${rel.name}.take`, 'must be a whole number ≥ 0 inside include');
    }
    const s = `efc_s${depth}`;
    return sql`coalesce((select jsonb_agg(${sql.raw(`${s}.o order by ${s}.n`)}) from (select ${obj} as o, row_number() over (order by ${order}) as n from ${sql.raw(from)} where ${sql.raw(cond)}${where ? sql` and ${where}` : sql``} order by ${order}${take !== undefined ? sql` limit ${sql.param(take)}` : sql``}${args['skip'] ? sql` offset ${sql.param(args['skip'])}` : sql``}) ${sql.raw(s)}), '[]'::jsonb)`;
  }

  /**
   * Where a relation's records come from, for rows of this table aliased `owner`: the FROM
   * (target aliased `a`, plus its join table aliased `j` when there is one) and the
   * condition tying them to the owner row.
   */
  private relationSource(
    rel: Relation,
    owner: string,
    a: string,
    j: string,
  ): { T: TableRuntime; from: string; cond: string; defaultOrder: string } {
    const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
    const target = `${q(T.tbl.table)} ${a}`;
    const ownerId = `${owner}.${q('id')}`;
    if (rel.via === 'fk') {
      return {
        T,
        from: target,
        cond: `${a}.${q('id')} = ${owner}.${q(rel.column)}`,
        defaultOrder: `${a}.${q('id')}`,
      };
    }
    let from: string;
    let cond: string;
    let defaultOrder: string;
    if (rel.via === 'join') {
      from = `${q(rel.join.table)} ${j} join ${target} on ${a}.${q('id')} = ${j}.ref_id`;
      cond = `${j}.owner_id = ${ownerId}`;
      defaultOrder = `${j}.position`;
    } else {
      // A back-relation: the target's field pointing here — a column, or its join table.
      const join = T.tbl.joins.get(rel.foreignKey);
      const column = T.tbl.columns.get(rel.foreignKey);
      const refs = join ? join.target : column?.node?.kind === 'scalar' && column.node.def.ref;
      if (refs !== this.name) {
        throw new Error(
          `[EFC] ${this.name}.${rel.name}: ${rel.target}.${rel.foreignKey} must be a ref to ${this.name}`,
        );
      }
      if (join) {
        if (rel.kind === 'one') {
          throw new Error(
            `[EFC] ${this.name}.${rel.name}: ${rel.target}.${rel.foreignKey} is many-to-many — use hasMany`,
          );
        }
        from = `${q(join.table)} ${j} join ${target} on ${a}.${q('id')} = ${j}.owner_id`;
        cond = `${j}.ref_id = ${ownerId}`;
      } else {
        if (rel.kind === 'one' && !column!.node!.def.unique) {
          throw new Error(
            `[EFC] ${this.name}.${rel.name}: hasOne needs ${rel.target}.${rel.foreignKey} to be unique (one ${rel.target} per ${this.name}) — or use hasMany`,
          );
        }
        from = target;
        cond = `${a}.${q(column!.column)} = ${ownerId}`;
      }
      defaultOrder = `${a}.${q('id')}`;
    }
    return { T, from, cond, defaultOrder };
  }

  // ── nested writes ──────────────────────────────────────────────────────────

  /** Whether `data` writes related records (connect / create / … on a relation). */
  private hasNested(data: unknown): boolean {
    if (!isPlainObject(data)) return false;
    return Object.entries(data).some(([key, v]) => {
      const rel = this.relations().get(key);
      if (!rel || v === undefined) return false;
      if (rel.via === 'back') return true;
      if (!isPlainObject(v)) return false;
      // A ref holds an id, never an object: any object there is a nested write (or a mistake
      // resolveNested explains). A many-to-many field also takes set / push / pull of ids.
      if (rel.via === 'fk') return true;
      const keys = Object.keys(v);
      if (keys.some((k) => !['set', 'push', 'pull'].includes(k))) return true;
      // `set: [{ id }]` / unique wheres on a many-to-many field.
      return rel.via === 'join' && Array.isArray(v['set']) && v['set'].some(isPlainObject);
    });
  }

  /** The id of the `rel` record a unique where (or a bare id) names; 400 when none does. */
  private async connectId(rel: Relation, w: unknown, path: string): Promise<unknown> {
    const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
    const where = isPlainObject(w) ? w : { id: w };
    const found = await T.findUnique({ where, select: { id: true } });
    if (!found) {
      throw new ModelValidationError(this.name, [
        { path, message: `no ${rel.target} matches ${JSON.stringify(where, idJson)}` },
      ]);
    }
    return found['id'];
  }

  private async connectOrCreateId(rel: Relation, arg: unknown, path: string): Promise<unknown> {
    if (!isPlainObject(arg) || !isPlainObject(arg['where']) || !isPlainObject(arg['create'])) {
      this.fail(path, 'connectOrCreate needs { where, create }');
    }
    const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
    const found = await T.findUnique({ where: arg['where'], select: { id: true } });
    return found ? found['id'] : (await T.createNested({ data: arg['create'] }))['id'];
  }

  /**
   * Splits nested relation writes out of `data`: own refs and many-to-many fields are
   * resolved to ids before the row is written; back-relations become steps to run with
   * the owner's id afterwards. Runs inside the caller's transaction.
   */
  private async resolveNested(
    data: AnyRecord,
    mode: 'create' | 'update',
  ): Promise<{ data: AnyRecord; after: ((id: unknown) => Promise<void>)[] }> {
    const out: AnyRecord = { ...data };
    const after: ((id: unknown) => Promise<void>)[] = [];
    const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

    for (const [key, v] of Object.entries(data)) {
      const rel = this.relations().get(key);
      if (!rel || v === undefined) continue;
      const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
      const ops = isPlainObject(v) ? v : undefined;
      for (const op of Object.keys(ops ?? {})) {
        const allowed =
          rel.via === 'fk'
            ? ONE_OPS
            : rel.via === 'join'
              ? JOIN_OPS
              : rel.kind === 'one'
                ? BACK_ONE_OPS
                : BACK_MANY_OPS;
        if (!allowed.has(op)) {
          this.fail(key, `"${op}" isn't a nested write here (use ${[...allowed].join(', ')})`);
        }
      }

      if (rel.via === 'fk') {
        if (!ops) continue; // a plain id
        if (ops['disconnect']) {
          if (mode === 'create') this.fail(key, 'disconnect only applies to updates');
          out[key] = null;
        } else if (ops['connect'] !== undefined) {
          out[key] = await this.connectId(rel, ops['connect'], key);
        } else if (ops['connectOrCreate'] !== undefined) {
          out[key] = await this.connectOrCreateId(rel, ops['connectOrCreate'], key);
        } else if (ops['create'] !== undefined) {
          out[key] = (await T.createNested({ data: ops['create'] }))['id'];
        }
        continue;
      }

      if (rel.via === 'join') {
        if (!ops || !this.hasNested({ [key]: v })) continue; // ids, set / push / pull of ids
        const ids = async (items: unknown[]) => {
          const got: unknown[] = [];
          for (const w of items) got.push(await this.connectId(rel, w, key));
          return got;
        };
        const added = await ids(list(ops['connect']));
        for (const a of list(ops['connectOrCreate'])) {
          added.push(await this.connectOrCreateId(rel, a, key));
        }
        for (const c of list(ops['create'])) added.push((await T.createNested({ data: c }))['id']);
        const removed: unknown[] = [];
        for (const w of list(ops['disconnect'])) {
          const where = isPlainObject(w) ? w : { id: w };
          const found = await T.findUnique({ where, select: { id: true } });
          if (found) removed.push(found['id']);
        }
        const gone = new Set(removed.map(String));
        if (ops['set'] !== undefined || mode === 'create') {
          const base = ops['set'] === undefined ? [] : await ids(list(ops['set']));
          const all = dedupe([...base, ...added]).filter((x) => !gone.has(String(x)));
          out[key] = mode === 'create' ? all : { set: all };
        } else {
          out[key] = {
            ...(added.length && { push: added }),
            ...(removed.length && { pull: removed }),
          };
        }
        continue;
      }

      // A back-relation: the other model's `foreignKey` field points here.
      delete out[key];
      const fk = rel.foreignKey;
      const many = T.tbl.joins.has(fk); // their side is many-to-many
      const mine = (owner: unknown): AnyRecord =>
        many ? { [fk]: { has: owner } } : { [fk]: owner };
      const whereOf = (w: unknown) => (isPlainObject(w) ? w : { id: w });
      const link = async (owner: unknown, w: unknown) => {
        if (many) {
          const id = await this.connectId(rel, w, key);
          await T.updateNested({ where: { id }, data: { [fk]: { push: owner } } });
        } else {
          try {
            await T.updateNested({ where: whereOf(w), data: { [fk]: owner } });
          } catch (err) {
            if (isHttpError(err) && err.statusCode === 404) {
              throw new ModelValidationError(this.name, [
                {
                  path: key,
                  message: `no ${rel.target} matches ${JSON.stringify(whereOf(w), idJson)}`,
                },
              ]);
            }
            throw err;
          }
        }
      };
      const unlink = (owner: unknown, where?: AnyRecord) =>
        many
          ? T.updateManyLinks(fk, owner, where)
          : T.updateMany(
              { where: { AND: [mine(owner), ...(where ? [where] : [])] }, data: { [fk]: null } },
              false,
            );
      const createChild = (owner: unknown, c: unknown) => {
        if (!isPlainObject(c)) this.fail(key, 'create needs record data');
        return T.createNested({ data: { ...c, [fk]: many ? [owner] : owner } });
      };

      after.push(async (owner) => {
        if (rel.kind === 'one') {
          if (mode === 'update' && (ops?.['create'] || ops?.['connect'] || ops?.['disconnect'])) {
            await unlink(owner); // the current one, if any, steps aside
          }
          if (ops?.['delete']) await T.deleteMany({ where: mine(owner) });
          if (ops?.['connect'] !== undefined) await link(owner, ops['connect']);
          if (ops?.['create'] !== undefined) await createChild(owner, ops['create']);
          return;
        }
        if (ops?.['set'] !== undefined) {
          const keep = list(ops['set']).map(whereOf);
          await unlink(owner, keep.length ? { NOT: { OR: keep } } : undefined);
          for (const w of keep) await link(owner, w);
        }
        for (const w of list(ops?.['disconnect'])) await unlink(owner, whereOf(w));
        for (const w of list(ops?.['delete']))
          await T.deleteMany({ where: { AND: [mine(owner), whereOf(w)] } });
        if (ops?.['deleteMany'] !== undefined) {
          for (const w of list(ops['deleteMany'])) {
            await T.deleteMany({ where: { AND: [mine(owner), ...(isPlainObject(w) ? [w] : [])] } });
          }
        }
        for (const w of list(ops?.['connect'])) await link(owner, w);
        for (const c of list(ops?.['create'])) await createChild(owner, c);
      });
    }
    return { data: out, after };
  }

  /** Removes `owner` from the many-to-many field `fk` of the records `where` matches. */
  async updateManyLinks(fk: string, owner: unknown, where?: AnyRecord): Promise<void> {
    const matches = await this.findMany({
      where: { AND: [{ [fk]: { has: owner } }, ...(where ? [where] : [])] },
      select: { id: true },
    });
    const { sql } = await this.ready();
    await this.applyJoins(
      sql,
      matches.map((m) => ({ id: m['id'], ops: [{ field: fk, mode: 'pull', items: [owner] }] })),
    );
  }

  /** Runs a write whose data may hold nested writes, all in one transaction. */
  private withNested(
    data: unknown,
    mode: 'create' | 'update',
    write: (data: AnyRecord) => Promise<AnyRecord>,
  ): Promise<AnyRecord> {
    if (!this.hasNested(data)) return write(data as AnyRecord);
    return transaction(async () => {
      const { data: plain, after } = await this.resolveNested(data as AnyRecord, mode);
      const record = await write(plain);
      for (const step of after) await step(record['id']);
      return record;
    });
  }

  createNested(args: AnyRecord): Promise<AnyRecord> {
    return this.withNested(args['data'], 'create', (data) => this.create({ ...args, data }));
  }

  updateNested(args: AnyRecord): Promise<AnyRecord> {
    return this.withNested(args['data'], 'update', (data) => this.update({ ...args, data }));
  }

  /** upsert with nested writes: find, then update or create — in one transaction. */
  async upsertNested(args: AnyRecord): Promise<AnyRecord> {
    if (!this.hasNested(args['create']) && !this.hasNested(args['update']))
      return this.upsert(args);
    this.uniqueKey(args['where'], 'upsert');
    return transaction(async () => {
      const found = await this.findUnique({ where: args['where'], select: { id: true } });
      const { create, update, where, ...rest } = args;
      if (found)
        return this.updateNested({ ...rest, where: { id: found['id'] }, data: update ?? {} });
      const key = this.uniqueKey(where, 'upsert');
      const data = { ...(create as AnyRecord) };
      for (const f of key) if (data[f] === undefined) data[f] = where[f];
      return this.createNested({ ...rest, data });
    });
  }

  /** createMany / updateMany write rows only, as in Prisma. */
  noNested(data: unknown, op: string): void {
    for (const d of Array.isArray(data) ? data : [data]) {
      if (this.hasNested(d))
        this.fail(
          'data',
          `${op} doesn't take nested writes — use ${op === 'updateMany' ? 'update' : 'create'}`,
        );
    }
  }

  // ── relation filters ───────────────────────────────────────────────────────

  /** The compiled Drizzle table, once `ready()` has run (relation filters need it sync). */
  t: any;

  /**
   * Compiles (and auto-syncs) this table, and every table a relation filter in `wheres`
   * reaches, so `where()` can build those filters synchronously.
   */
  async ready(...wheres: unknown[]): Promise<{ t: any; sql: Sql }> {
    const out = await this.tbl.ready();
    this.t = out.t;
    for (const w of wheres) await this.prepareWhere(w);
    return out;
  }

  private async prepareWhere(where: unknown): Promise<void> {
    if (!isPlainObject(where)) return;
    for (const [key, value] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        for (const w of Array.isArray(value) ? value : [value]) await this.prepareWhere(w);
        continue;
      }
      const rel = this.relationFilterOf(key, value);
      if (!rel) continue;
      const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
      for (const sub of Object.values(value as AnyRecord)) await T.ready(sub);
    }
  }

  /** The relation `where.key` filters on, when `value` is a relation filter. */
  private relationFilterOf(key: string, value: unknown): Relation | undefined {
    const rel = this.relations().get(key);
    if (!rel) return undefined;
    const ops = rel.kind === 'many' ? ['some', 'every', 'none'] : ['is', 'isNot'];
    const keys = isPlainObject(value) ? Object.keys(value) : [];
    const isFilter = keys.length > 0 && keys.every((k) => ops.includes(k));
    // A ref / many-to-many field also takes its plain id filters; a back-relation only these.
    if (!isFilter && rel.via === 'back') {
      this.fail(`where.${key}`, `filter a relation with ${ops.join(' / ')}`);
    }
    return isFilter ? rel : undefined;
  }

  /** some / every / none, is / isNot → EXISTS subqueries on the related table. */
  private relationFilter(sql: Sql, rel: Relation, filter: AnyRecord, owner?: string): Sql {
    const a = `efc_f${++aliasSeq}`;
    const { T, from, cond } = this.relationSource(
      rel,
      owner ?? q(this.tbl.table),
      a,
      `efc_fj${aliasSeq}`,
    );
    if (T.t === undefined) {
      throw new Error(
        `[EFC] ${this.name}: relation filter on ${rel.name} before its table was ready`,
      );
    }
    const exists = (w: unknown, negate = false): Sql => {
      const inner = isPlainObject(w) ? T.where(sql, T.t, w, a) : undefined;
      const extra = inner
        ? negate
          ? sql` and not (${inner})`
          : sql` and ${inner}`
        : negate
          ? sql` and false`
          : sql``;
      return sql`exists (select 1 from ${sql.raw(from)} where ${sql.raw(cond)}${extra})`;
    };
    const parts: Sql[] = [];
    for (const [op, w] of Object.entries(filter)) {
      if (w === undefined) continue;
      switch (op) {
        case 'some':
          parts.push(exists(w));
          break;
        case 'none':
          parts.push(sql`not ${exists(w)}`);
          break;
        case 'every':
          parts.push(sql`not ${exists(w, true)}`);
          break;
        case 'is':
          parts.push(w === null ? sql`not ${exists(undefined)}` : exists(w));
          break;
        case 'isNot':
          parts.push(w === null ? exists(undefined) : sql`not ${exists(w)}`);
          break;
      }
    }
    return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
  }

  /** A record of this table (aliased `alias`) as jsonb, with its own includes. */
  private async jsonRecord(
    sql: Sql,
    t: any,
    args: AnyRecord,
    alias: string,
    depth: number,
  ): Promise<Sql> {
    const include = this.includeArg(args);
    const pairs: Sql[] = [];
    for (const f of this.projection(args)) {
      if (include?.[f]) continue; // loaded as a relation instead
      pairs.push(sql`${sql.raw(literal(f))}, ${this.jsonValue(sql, f, alias)}`);
    }
    for (const [name, arg] of Object.entries(include ?? {})) {
      if (!arg) continue;
      const expr = await this.relationExpr(sql, this.relation(name), relArgs(arg), alias, depth);
      pairs.push(sql`${sql.raw(literal(name))}, ${expr}`);
    }
    if (pairs.length === 0) return sql`'{}'::jsonb`;
    const chunks: Sql[] = [];
    for (let i = 0; i < pairs.length; i += JSON_PAIRS_PER_CALL) {
      chunks.push(
        sql`jsonb_build_object(${sql.join(pairs.slice(i, i + JSON_PAIRS_PER_CALL), sql`, `)})`,
      );
    }
    return sql.join(chunks, sql` || `);
  }

  // JSON can't hold bigints exactly, NaN/Infinity or decimals verbatim: send those as text.
  private jsonValue(sql: Sql, field: string, alias: string): Sql {
    const c = this.col(sql, field, alias);
    const spec = this.spec(field)!;
    if (this.join(field)) return sql`${c}::text[]`;
    const textual = (k?: string) => k === 'bigint' || k === 'double' || k === 'numeric';
    if (spec.kind === 'array') return textual(spec.item) ? sql`${c}::text[]` : c;
    return textual(spec.kind) ? sql`${c}::text` : c;
  }

  /** A record from `jsonRecord` → the same record a direct read returns. */
  private fromJson(json: AnyRecord, args: AnyRecord): AnyRecord {
    const include = this.includeArg(args);
    const keyed: AnyRecord = {};
    for (const f of this.projection(args)) {
      if (include?.[f]) continue;
      const v = json[f];
      const join = this.join(f);
      if (v == null || join) {
        keyed[f] = join && Array.isArray(v) ? this.joinValues(join, v) : v;
        continue;
      }
      const spec = this.spec(f)!;
      const one = (kind: string | undefined, x: unknown) =>
        x == null
          ? x
          : kind === 'timestamptz'
            ? new Date(x as string)
            : kind === 'double'
              ? Number(x)
              : kind === 'bigint' && spec.bigintAs === 'number'
                ? Number(x)
                : x;
      keyed[f] =
        spec.kind === 'array' && Array.isArray(v)
          ? v.map((x) => one(spec.item, x))
          : spec.kind === 'array'
            ? v
            : one(spec.kind, v);
    }
    const record = this.tbl.fromRow(keyed);
    for (const [name, arg] of Object.entries(include ?? {})) {
      if (arg) record[name] = this.decodeRelation(this.relation(name), json[name], relArgs(arg));
    }
    return record;
  }

  private decodeRelation(rel: Relation, value: unknown, args: AnyRecord): unknown {
    const T = runtimeOf(rel.target, `${this.name}.${rel.name}`);
    if (rel.kind === 'one') return value == null ? null : T.fromJson(value as AnyRecord, args);
    return ((value as AnyRecord[] | null) ?? []).map((v) => T.fromJson(v, args));
  }

  private attachIncludes(record: AnyRecord, row: AnyRecord, include: AnyRecord): void {
    for (const [name, arg] of Object.entries(include)) {
      if (!arg) continue;
      record[name] = this.decodeRelation(this.relation(name), row[incAlias(name)], relArgs(arg));
    }
  }

  /** A write with `include`: write, then read the record back with its relations. */
  async withInclude(
    args: AnyRecord,
    write: (args: AnyRecord) => Promise<AnyRecord>,
  ): Promise<AnyRecord> {
    if (!this.includeArg(args ?? {})) return write(args);
    const { include, select, omit, ...rest } = args;
    const record = await write(rest);
    const [full] = await this.findMany({ where: { id: record['id'] }, select, omit, include });
    return full ?? record;
  }

  /** `delete` with `include`: read the record and its relations, then delete it. */
  async deleteWithInclude(args: AnyRecord): Promise<AnyRecord> {
    if (!this.includeArg(args)) return this.delete(args);
    this.uniqueKey(args['where'], 'delete');
    return transaction(async () => {
      const [found] = await this.findMany({
        where: args['where'],
        select: args['select'],
        omit: args['omit'],
        include: args['include'],
        take: 1,
      });
      await this.delete({ where: args['where'] });
      return found!;
    });
  }

  async findFirst(args: AnyRecord = {}): Promise<AnyRecord | null> {
    const take = args['take'] as number | undefined;
    const rows = await this.findMany({ ...args, take: take !== undefined && take < 0 ? -1 : 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: AnyRecord): Promise<AnyRecord | null> {
    this.uniqueKey(args['where'], 'findUnique');
    return this.findFirst({
      where: args['where'],
      select: args['select'],
      omit: args['omit'],
      include: args['include'],
    });
  }

  async orThrow<R>(p: Promise<R | null>): Promise<R> {
    const r = await p;
    if (r === null) throw new HttpError(404, `${this.name} not found`);
    return r;
  }

  async count(args: AnyRecord = {}): Promise<number | AnyRecord> {
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const select = args['select'] as AnyRecord | undefined;
      const counted = select
        ? Object.entries(select).filter(([f, on]) => on && (f === '_all' || this.spec(f)))
        : [['_all', true]];
      const exprs = sql.join(
        counted.map(([f]) =>
          f === '_all'
            ? sql`count(*)::int as ${sql.raw(q('_all'))}`
            : sql`count(${this.col(sql, f as string, 'efc_rows')})::int as ${sql.raw(q(f as string))}`,
        ),
        sql`, `,
      );
      const { query } = this.readQuery(
        sql,
        t,
        { ...args, select: undefined, distinct: args['distinct'] },
        sql`*`,
      );
      const [row] = (
        await this.tbl.client().execute(sql`select ${exprs} from (${query}) as efc_rows`)
      ).rows as AnyRecord[];
      return select ? (row as AnyRecord) : (row!['_all'] as number);
    });
  }

  // ── aggregates ─────────────────────────────────────────────────────────────

  private aggregateSpec(args: AnyRecord): { agg: Aggregate; field: string; alias: string }[] {
    const out: { agg: Aggregate; field: string; alias: string }[] = [];
    for (const agg of AGGREGATES) {
      const v = args[agg];
      if (!v) continue;
      if (v === true) {
        if (agg !== '_count') this.fail(agg, `${agg} needs fields, e.g. { total: true }`);
        out.push({ agg, field: '_all', alias: `${agg}._all` });
        continue;
      }
      for (const [field, on] of Object.entries(v as AnyRecord)) {
        if (!on) continue;
        if (field === '_all' && agg === '_count') {
          out.push({ agg, field, alias: `${agg}._all` });
          continue;
        }
        const spec = this.spec(field);
        if (!spec) this.fail(`${agg}.${field}`, 'unknown field');
        if (agg !== '_count' && this.join(field)) {
          this.fail(`${agg}.${field}`, `${agg} doesn't apply to a many-to-many field`);
        }
        if ((agg === '_sum' || agg === '_avg') && !NUMERIC_KINDS.has(spec.kind)) {
          this.fail(`${agg}.${field}`, `${agg} needs a numeric field`);
        }
        out.push({ agg, field, alias: `${agg}.${field}` });
      }
    }
    return out;
  }

  private aggregateExpr(sql: Sql, agg: Aggregate, field: string): Sql {
    if (agg === '_count')
      return field === '_all' ? sql`count(*)` : sql`count(${this.col(sql, field)})`;
    const fn = { _sum: 'sum', _avg: 'avg', _min: 'min', _max: 'max' }[agg];
    return sql`${sql.raw(fn)}(${this.col(sql, field)})`;
  }

  /** Raw aggregate value → the type Prisma returns for it. */
  private aggregateValue(t: any, agg: Aggregate, field: string, v: unknown): unknown {
    if (agg === '_count') return Number(v);
    if (v == null) return null;
    const spec = this.spec(field)!;
    if (agg === '_min' || agg === '_max') return t[field].mapFromDriverValue(v);
    if (spec.kind === 'numeric') return String(v);
    if (agg === '_sum' && spec.kind === 'bigint') return BigInt(String(v).split('.')[0]!);
    return Number(v);
  }

  private aggregateRow(
    t: any,
    specs: ReturnType<TableRuntime['aggregateSpec']>,
    row: AnyRecord,
    args: AnyRecord,
  ): AnyRecord {
    const out: AnyRecord = {};
    for (const { agg, field, alias } of specs) {
      const value = this.aggregateValue(t, agg, field, row[alias]);
      // `_count: true` → a number; `_count: { _all: true, … }` → an object, as in Prisma.
      if (agg === '_count' && args['_count'] === true) out[agg] = value;
      else (out[agg] ??= {})[field] = value;
    }
    return out;
  }

  async aggregate(args: AnyRecord = {}): Promise<AnyRecord> {
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const specs = this.aggregateSpec(args);
      if (specs.length === 0) return {};
      const exprs = sql.join(
        specs.map((s) => sql`${this.aggregateExpr(sql, s.agg, s.field)} as ${sql.raw(q(s.alias))}`),
        sql`, `,
      );
      const { query } = this.readQuery(sql, t, { ...args, select: undefined }, sql`*`);
      const [row] = (
        await this.tbl.client().execute(sql`select ${exprs} from (${query}) as efc_rows`)
      ).rows as AnyRecord[];
      return this.aggregateRow(t, specs, row!, args);
    });
  }

  private havingSql(sql: Sql, t: any, having: AnyRecord | undefined): Sql | undefined {
    if (!having) return undefined;
    const parts: Sql[] = [];
    for (const [key, value] of Object.entries(having)) {
      if (value === undefined) continue;
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        const list = (Array.isArray(value) ? value : [value]) as AnyRecord[];
        const subs = list.map((h) => this.havingSql(sql, t, h) ?? sql`true`);
        const joined = sql.join(
          subs,
          key === 'OR' ? sql` or ` : key === 'NOT' ? sql` or ` : sql` and `,
        );
        parts.push(key === 'NOT' ? sql`not (${joined})` : sql`(${joined})`);
        continue;
      }
      const spec = this.spec(key);
      if (!spec) this.fail(`having.${key}`, 'unknown field');
      const filter = value as AnyRecord;
      const aggKeys = isPlainObject(filter)
        ? Object.keys(filter).filter((k) => (AGGREGATES as readonly string[]).includes(k))
        : [];
      if (aggKeys.length === 0) {
        parts.push(this.fieldFilter(sql, t, spec, filter));
        continue;
      }
      for (const agg of aggKeys as Aggregate[]) {
        const expr = this.aggregateExpr(sql, agg, key);
        for (const [op, v] of Object.entries(filter[agg] as AnyRecord)) {
          const opSql = { equals: '=', not: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
          if (!opSql) this.fail(`having.${key}.${agg}`, `unknown filter "${op}"`);
          parts.push(
            sql`${expr} ${sql.raw(opSql)} ${sql.param(typeof v === 'bigint' ? String(v) : v instanceof Date ? v : v)}`,
          );
        }
      }
    }
    return parts.length ? sql.join(parts, sql` and `) : undefined;
  }

  async groupBy(args: AnyRecord): Promise<AnyRecord[]> {
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const by = (Array.isArray(args['by']) ? args['by'] : [args['by']]) as string[];
      if (by.length === 0) this.fail('by', 'groupBy needs at least one field');
      for (const f of by) {
        if (!this.spec(f)) this.fail(`by.${f}`, 'unknown field');
        if (this.join(f)) this.fail(`by.${f}`, "can't group by a many-to-many field");
      }
      const specs = this.aggregateSpec(args);
      const select = sql.join(
        [
          ...by.map((f) => this.col(sql, f)),
          ...specs.map(
            (s) => sql`${this.aggregateExpr(sql, s.agg, s.field)} as ${sql.raw(q(s.alias))}`,
          ),
        ],
        sql`, `,
      );
      const where = this.where(sql, t, args['where']);
      const having = this.havingSql(sql, t, args['having']);
      const orders: Sql[] = [];
      for (const entry of (Array.isArray(args['orderBy'])
        ? args['orderBy']
        : args['orderBy']
          ? [args['orderBy']]
          : []) as AnyRecord[]) {
        for (const [key, dir] of Object.entries(entry)) {
          if ((AGGREGATES as readonly string[]).includes(key)) {
            for (const [field, d] of Object.entries(dir as AnyRecord)) {
              orders.push(
                sql`${this.aggregateExpr(sql, key as Aggregate, field)} ${sql.raw(d === 'desc' ? 'desc' : 'asc')}`,
              );
            }
          } else if (this.spec(key)) {
            if (!by.includes(key))
              this.fail(`orderBy.${key}`, 'groupBy can only order by grouped fields or aggregates');
            const d = isPlainObject(dir) ? dir['sort'] : dir;
            orders.push(sql`${this.col(sql, key)} ${sql.raw(d === 'desc' ? 'desc' : 'asc')}`);
          }
        }
      }
      const query = sql`select ${select} from ${sql.raw(q(this.tbl.table))}${where ? sql` where ${where}` : sql``} group by ${sql.join(
        by.map((f) => this.col(sql, f)),
        sql`, `,
      )}${having ? sql` having ${having}` : sql``}${orders.length ? sql` order by ${sql.join(orders, sql`, `)}` : sql``}${
        args['take'] !== undefined ? sql` limit ${sql.param(args['take'])}` : sql``
      }${args['skip'] ? sql` offset ${sql.param(args['skip'])}` : sql``}`;
      const rows = (await this.tbl.client().execute(query)).rows as AnyRecord[];
      return rows.map((row) => {
        const keyed: AnyRecord = {};
        for (const f of by) keyed[f] = row[this.spec(f)!.column];
        const out = this.project(
          this.fromRaw(t, Object.fromEntries(by.map((f) => [this.spec(f)!.column, keyed[f]]))),
          by,
        );
        for (const f of by) if (!(f in out)) out[f] = null;
        return { ...out, ...this.aggregateRow(t, specs, row, args) };
      });
    });
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** Prisma update data → SET expressions and many-to-many changes, validated. */
  private async setList(
    sql: Sql,
    t: any,
    data: AnyRecord,
    alias?: string,
  ): Promise<{ sets: Sql[]; joinOps: JoinOp[] }> {
    const sets: Sql[] = [];
    const joinOps: JoinOp[] = [];
    const plain: AnyRecord = {};
    const issues: FieldIssue[] = [];
    const ref = (f: string) => this.col(sql, f, alias);
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const spec = this.spec(field);
      if (
        !spec ||
        field === 'id' ||
        field === this.tbl.ts.createdAt ||
        field === this.tbl.ts.updatedAt
      ) {
        continue; // undeclared / managed: ignored, as on writes everywhere
      }
      if (this.join(field)) {
        // A list of ids, { set: [...] } or { push: id | [...] }.
        const entries = isPlainObject(value) ? Object.entries(value) : [['set', value]];
        for (const [op, v] of entries) {
          if (v === undefined) continue;
          if (op !== 'set' && op !== 'push' && op !== 'pull') {
            issues.push({ path: field, message: `unknown update operation "${op}"` });
            continue;
          }
          const items = v === null ? [] : Array.isArray(v) ? v : op !== 'set' ? [v] : v;
          await this.tbl.validate({ [field]: items }, true);
          joinOps.push({ field, mode: op, items: items as unknown[] });
        }
        continue;
      }
      const ops = isPlainObject(value) && spec.kind !== 'jsonb' ? value : undefined;
      if (!ops) {
        plain[field] = value;
        continue;
      }
      for (const [op, v] of Object.entries(ops)) {
        if (v === undefined) continue;
        if (op === 'set') {
          plain[field] = v;
        } else if (
          op === 'increment' ||
          op === 'decrement' ||
          op === 'multiply' ||
          op === 'divide'
        ) {
          if (!NUMERIC_KINDS.has(spec.kind)) {
            issues.push({ path: field, message: `${op} only applies to number fields` });
            continue;
          }
          const okOperand =
            (typeof v === 'number' && Number.isFinite(v)) ||
            typeof v === 'bigint' ||
            (spec.kind === 'numeric' && typeof v === 'string');
          if (!okOperand) {
            issues.push({ path: field, message: `${op} needs a number` });
            continue;
          }
          const sym = { increment: '+', decrement: '-', multiply: '*', divide: '/' }[op];
          sets.push(
            sql`${this.col(sql, field)} = ${ref(field)} ${sql.raw(sym)} ${this.val(sql, t, field, v)}`,
          );
        } else if (op === 'push' && spec.kind === 'array') {
          const items = Array.isArray(v) ? v : [v];
          sets.push(
            sql`${this.col(sql, field)} = coalesce(${ref(field)}, ${sql.raw(`'{}'::${spec.ddl}`)}) || ${this.val(sql, t, field, items)}::${sql.raw(spec.ddl)}`,
          );
        } else {
          issues.push({ path: field, message: `unknown update operation "${op}"` });
        }
      }
    }
    if (issues.length) throw new ModelValidationError(this.name, issues);
    await this.tbl.validate(plain, true);
    for (const [field, v] of Object.entries(plain)) {
      sets.push(
        sql`${this.col(sql, field)} = ${v === null ? sql`null` : this.val(sql, t, field, v)}`,
      );
    }
    if (this.tbl.ts.updatedAt && (sets.length || joinOps.length)) {
      sets.push(
        sql`${this.col(sql, this.tbl.ts.updatedAt)} = ${this.val(sql, t, this.tbl.ts.updatedAt, new Date())}`,
      );
    }
    return { sets, joinOps };
  }

  // ── many-to-many links ─────────────────────────────────────────────────────

  /** Splits an insert row into its columns and the `set` ops for its many-to-many fields. */
  private splitJoins(row: AnyRecord): { row: AnyRecord; ops: JoinOp[] } {
    if (this.tbl.joins.size === 0) return { row, ops: [] };
    const out: AnyRecord = {};
    const ops: JoinOp[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (this.join(k)) ops.push({ field: k, mode: 'set', items: (v as unknown[] | null) ?? [] });
      else out[k] = v;
    }
    return { row: out, ops };
  }

  private exec(query: Sql): Promise<{ rows: AnyRecord[]; rowCount?: number | null }> {
    return this.tbl.client().execute(query);
  }

  /** Applies many-to-many changes for each owner id, in the current transaction. */
  private async applyJoins(sql: Sql, ops: { id: unknown; ops: JoinOp[] }[]): Promise<void> {
    const idDdl = this.tbl.columns.get('id')!.ddl;
    const byField = new Map<string, { id: unknown; op: JoinOp }[]>();
    for (const { id, ops: list } of ops) {
      for (const op of list) {
        const entry = byField.get(op.field) ?? [];
        entry.push({ id, op });
        byField.set(op.field, entry);
      }
    }
    for (const [field, entries] of byField) {
      const join = this.join(field)!;
      const jt = sql.raw(q(join.table));
      const sets = entries.filter((e) => e.op.mode === 'set');
      if (sets.length) {
        // Drop each owner's links that aren't in its new list (unnest pairs owner + list).
        const owners = sets.map((e) => idText(e.id));
        const lists = sets.map((e) => `{${dedupe(e.op.items).map(idText).join(',')}}`);
        await this.exec(
          sql`delete from ${jt} as efc_j using unnest(${sql.param(owners)}::${sql.raw(idDdl)}[], ${sql.param(lists)}::text[]) as w(owner, ids) where efc_j.owner_id = w.owner and not (efc_j.ref_id = any(w.ids::${sql.raw(join.ddl)}))`,
        );
      }
      const pulls = entries.filter((e) => e.op.mode === 'pull');
      if (pulls.length) {
        const pairs = pulls.flatMap((e) => dedupe(e.op.items).map((ref) => [e.id, ref] as const));
        if (pairs.length) {
          await this.exec(
            sql`delete from ${jt} as efc_j using unnest(${sql.param(pairs.map((p) => idText(p[0])))}::${sql.raw(idDdl)}[], ${sql.param(pairs.map((p) => idText(p[1])))}::${sql.raw(join.ddl)}) as d(o, r) where efc_j.owner_id = d.o and efc_j.ref_id = d.r`,
          );
        }
      }
      // One insert for every new link: (owner, ref, position).
      const adds = entries.filter((e) => e.op.mode !== 'pull');
      const links: [unknown, unknown, number][] = [];
      for (const { id, op } of adds) {
        dedupe(op.items).forEach((ref, i) => links.push([id, ref, i + 1]));
      }
      if (links.length === 0) continue;
      const pushes = new Set(adds.filter((e) => e.op.mode === 'push').map((e) => idText(e.id)));
      const owners = sql`${sql.param(links.map((l) => idText(l[0])))}::${sql.raw(idDdl)}[]`;
      const refs = sql`${sql.param(links.map((l) => idText(l[1])))}::${sql.raw(join.ddl)}`;
      const pos = sql`${sql.param(links.map((l) => l[2]))}::integer[]`;
      if (pushes.size === 0) {
        await this.exec(
          sql`insert into ${jt} (owner_id, ref_id, position) select * from unnest(${owners}, ${refs}, ${pos}) on conflict (owner_id, ref_id) do update set position = excluded.position`,
        );
      } else {
        // Appended after the owner's current last link; ids it already has stay put.
        await this.exec(
          sql`insert into ${jt} (owner_id, ref_id, position) select l.o, l.r, coalesce((select max(efc_j.position) from ${jt} efc_j where efc_j.owner_id = l.o), 0) + l.p from unnest(${owners}, ${refs}, ${pos}) as l(o, r, p) on conflict (owner_id, ref_id) do nothing`,
        );
      }
    }
  }

  /** The current links of `fields` for these owners, read in one statement. */
  private async loadJoins(
    sql: Sql,
    ids: unknown[],
    fields: string[],
  ): Promise<Map<string, Map<string, unknown[]>>> {
    const out = new Map<string, Map<string, unknown[]>>();
    const joins = fields.map((f) => this.join(f)!).filter(Boolean);
    if (joins.length === 0 || ids.length === 0) return out;
    const idDdl = this.tbl.columns.get('id')!.ddl;
    const owners = sql`${sql.param(ids.map(idText))}::${sql.raw(idDdl)}[]`;
    const parts = joins.map(
      (j) =>
        sql`select ${sql.param(j.field)}::text as f, owner_id::text as o, array_agg(ref_id::text order by position) as ids from ${sql.raw(q(j.table))} where owner_id = any(${owners}) group by owner_id`,
    );
    const { rows } = await this.exec(sql.join(parts, sql` union all `));
    for (const j of joins) out.set(j.field, new Map());
    for (const r of rows) {
      const join = this.join(r['f'] as string)!;
      out.get(join.field)!.set(r['o'] as string, this.joinValues(join, r['ids'] as unknown[]));
    }
    return out;
  }

  /** Writes the loaded links into records (owners without any get an empty list). */
  private attachJoins(records: AnyRecord[], loaded: Map<string, Map<string, unknown[]>>): void {
    for (const [field, byOwner] of loaded) {
      for (const r of records) r[field] = byOwner.get(String(r['id'])) ?? [];
    }
  }

  /** Runs `fn` in a transaction when it changes links (main statement + link statements). */
  private withLinks<R>(changesLinks: boolean, fn: () => Promise<R>): Promise<R> {
    return changesLinks ? transaction(fn) : fn();
  }

  private insertSql(sql: Sql, t: any, rows: AnyRecord[]): { head: Sql; values: Sql } {
    const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const head = sql`insert into ${sql.raw(q(this.tbl.table))} (${sql.join(
      fields.map((f) => this.col(sql, f)),
      sql`, `,
    )})`;
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${sql.join(
            fields.map((f) => (r[f] === undefined ? sql`default` : sql`${sql.param(r[f], t[f])}`)),
            sql`, `,
          )})`,
      ),
      sql`, `,
    );
    return { head, values };
  }

  private async prepare(data: AnyRecord | undefined): Promise<AnyRecord> {
    if (!isPlainObject(data)) this.fail('data', 'must be an object');
    return this.tbl.prepareInsert(data);
  }

  async create(args: AnyRecord): Promise<AnyRecord> {
    const { t, sql } = await this.ready();
    return this.tbl.guard(async () => {
      const { row, ops } = this.splitJoins(await this.prepare(args['data']));
      return this.withLinks(
        ops.some((o) => o.items.length),
        async () => {
          const { head, values } = this.insertSql(sql, t, [row]);
          const [inserted] = (await this.exec(sql`${head} values ${values} returning *`)).rows;
          const record = this.fromRaw(t, inserted!);
          await this.applyJoins(sql, [
            { id: record['id'], ops: ops.filter((o) => o.items.length) },
          ]);
          // A new record's links are exactly what was written.
          for (const join of this.tbl.joins.values()) {
            const op = ops.find((o) => o.field === join.field);
            record[join.field] = this.joinValues(join, op ? dedupe(op.items).map(idText) : []);
          }
          return this.project(record, this.projection(args));
        },
      );
    });
  }

  async createMany(args: AnyRecord, returning: boolean): Promise<{ count: number } | AnyRecord[]> {
    const { t, sql } = await this.ready();
    return this.tbl.guard(async () => {
      const data = (Array.isArray(args['data']) ? args['data'] : [args['data']]) as AnyRecord[];
      if (data.length === 0) return returning ? [] : { count: 0 };
      const split = (await Promise.all(data.map((d) => this.prepare(d)))).map((r) =>
        this.splitJoins(r),
      );
      const linked = split.some((x) => x.ops.some((o) => o.items.length));
      return this.withLinks(linked, async () => {
        if (linked)
          await this.assignIds(
            sql,
            split.map((x) => x.row),
          );
        const { head, values } = this.insertSql(
          sql,
          t,
          split.map((x) => x.row),
        );
        const conflict = args['skipDuplicates'] ? sql` on conflict do nothing` : sql``;
        const result = await this.exec(
          sql`${head} values ${values}${conflict}${returning ? sql` returning *` : linked ? sql` returning ${this.col(sql, 'id')}` : sql``}`,
        );
        if (linked) {
          // Only rows that were inserted (skipDuplicates may skip some) get links.
          const inserted = new Set(result.rows.map((r) => String(r['id'])));
          await this.applyJoins(
            sql,
            split
              .filter((x) => inserted.has(String(x.row['id'])))
              .map((x) => ({ id: x.row['id'], ops: x.ops.filter((o) => o.items.length) })),
          );
        }
        if (!returning) return { count: linked ? result.rows.length : (result.rowCount ?? 0) };
        const fields = this.projection(args);
        const records = result.rows.map((r) => this.fromRaw(t, r));
        if (this.tbl.joins.size) {
          const ops = new Map(split.map((x) => [String(x.row['id']), x.ops]));
          for (const record of records) {
            for (const join of this.tbl.joins.values()) {
              const op = ops.get(String(record['id']))?.find((o) => o.field === join.field);
              record[join.field] = this.joinValues(join, op ? dedupe(op.items).map(idText) : []);
            }
          }
        }
        return records.map((r) => this.project(r, fields));
      });
    });
  }

  /** Gives rows without an id one up front, so their links can name their owner. */
  private async assignIds(sql: Sql, rows: AnyRecord[]): Promise<void> {
    const missing = rows.filter((r) => r['id'] === undefined);
    if (missing.length === 0) return;
    if (this.tbl.idKind === 'uuid') {
      for (const r of missing) r['id'] = randomUUID();
      return;
    }
    const { rows: ids } = await this.exec(
      sql`select nextval(pg_get_serial_sequence(${sql.param(q(this.tbl.table))}, 'id'))::text as id from generate_series(1, ${sql.param(missing.length)})`,
    );
    missing.forEach((r, i) => {
      const id = ids[i]!['id'] as string;
      r['id'] = this.tbl.idKind === 'bigserial' ? BigInt(id) : Number(id);
    });
  }

  /** Reloads the links of the fields `ops` changed into `records`. */
  private async refreshJoins(sql: Sql, records: AnyRecord[], ops: JoinOp[]): Promise<void> {
    const fields = [...new Set(ops.map((o) => o.field))];
    if (fields.length === 0 || records.length === 0) return;
    this.attachJoins(
      records,
      await this.loadJoins(
        sql,
        records.map((r) => r['id']),
        fields,
      ),
    );
  }

  async update(args: AnyRecord): Promise<AnyRecord> {
    this.uniqueKey(args['where'], 'update');
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const { sets, joinOps } = await this.setList(sql, t, args['data'] ?? {});
      return this.withLinks(joinOps.length > 0, async () => {
        const where = this.where(sql, t, args['where'])!;
        const links = this.joinColumns(sql, [...this.tbl.joins.keys()]);
        const extra = links.length ? sql`, ${sql.join(links, sql`, `)}` : sql``;
        const query = sets.length
          ? sql`update ${sql.raw(q(this.tbl.table))} set ${sql.join(sets, sql`, `)} where ${where} returning *${extra}`
          : sql`select *${extra} from ${sql.raw(q(this.tbl.table))} where ${where} limit 1`;
        const [row] = (await this.exec(query)).rows;
        if (!row) throw new HttpError(404, `${this.name} not found`);
        const record = this.fromRaw(t, row);
        await this.applyJoins(sql, [{ id: record['id'], ops: joinOps }]);
        await this.refreshJoins(sql, [record], joinOps);
        return this.project(record, this.projection(args));
      });
    });
  }

  async updateMany(args: AnyRecord, returning: boolean): Promise<{ count: number } | AnyRecord[]> {
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const { sets, joinOps } = await this.setList(sql, t, args['data'] ?? {});
      if (sets.length === 0 && joinOps.length === 0) {
        if (!returning) return { count: 0 };
        return this.findMany({ where: args['where'], select: args['select'], omit: args['omit'] });
      }
      return this.withLinks(joinOps.length > 0, async () => {
        const where = this.where(sql, t, args['where']) ?? sql`true`;
        const links = returning ? this.joinColumns(sql, [...this.tbl.joins.keys()]) : [];
        const list = returning
          ? sql` returning *${links.length ? sql`, ${sql.join(links, sql`, `)}` : sql``}`
          : joinOps.length
            ? sql` returning ${this.col(sql, 'id')}`
            : sql``;
        // Only links change (no timestamps to touch): select the matching rows instead.
        const result = await this.exec(
          sets.length
            ? sql`update ${sql.raw(q(this.tbl.table))} set ${sql.join(sets, sql`, `)} where ${where}${list}`
            : sql`select ${returning ? sql`*${links.length ? sql`, ${sql.join(links, sql`, `)}` : sql``}` : this.col(sql, 'id')} from ${sql.raw(q(this.tbl.table))} where ${where}`,
        );
        const records = result.rows.map((r) => (returning ? this.fromRaw(t, r) : r));
        await this.applyJoins(
          sql,
          records.map((r) => ({ id: r['id'], ops: joinOps })),
        );
        if (!returning)
          return { count: joinOps.length ? result.rows.length : (result.rowCount ?? 0) };
        await this.refreshJoins(sql, records, joinOps);
        const fields = this.projection(args);
        return records.map((r) => this.project(r, fields));
      });
    });
  }

  async upsert(args: AnyRecord): Promise<AnyRecord> {
    const key = this.uniqueKey(args['where'], 'upsert');
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const { row, ops: createOps } = this.splitJoins(await this.prepare(args['create']));
      for (const f of key) {
        if (row[f] === undefined) row[f] = this.tbl.toDb(f, args['where'][f]);
      }
      const { head, values } = this.insertSql(sql, t, [row]);
      const table = q(this.tbl.table);
      const update = await this.setList(sql, t, args['update'] ?? {}, table);
      const { joinOps } = update;
      let { sets } = update;
      // Nothing to update: a no-op assignment still makes RETURNING yield the existing row.
      if (sets.length === 0)
        sets = [sql`${this.col(sql, key[0]!)} = excluded.${this.col(sql, key[0]!)}`];
      const target = sql.join(
        key.map((f) => this.col(sql, f)),
        sql`, `,
      );
      const extra = Object.keys(args['where']).filter((f) => !key.includes(f));
      const cond = extra.length
        ? sql` where ${this.where(sql, t, Object.fromEntries(extra.map((f) => [f, args['where'][f]])))}`
        : sql``;
      const linked = this.tbl.joins.size > 0;
      const links = this.joinColumns(sql, [...this.tbl.joins.keys()], table);
      const returning = linked
        ? sql` returning *, (${sql.raw(table)}.xmax = 0) as efc_inserted, ${sql.join(links, sql`, `)}`
        : sql` returning *`;
      return this.withLinks(
        createOps.some((o) => o.items.length) || joinOps.length > 0,
        async () => {
          const [out] = (
            await this.exec(
              sql`${head} values ${values} on conflict (${target}) do update set ${sql.join(sets, sql`, `)}${cond}${returning}`,
            )
          ).rows;
          if (!out) throw new HttpError(404, `${this.name} not found`);
          const record = this.fromRaw(t, out);
          if (linked) {
            // Inserted: its create lists; updated: the update's changes (set: [] clears).
            const ops = out['efc_inserted'] ? createOps.filter((o) => o.items.length) : joinOps;
            await this.applyJoins(sql, [{ id: record['id'], ops }]);
            await this.refreshJoins(sql, [record], ops);
          }
          return this.project(record, this.projection(args));
        },
      );
    });
  }

  async delete(args: AnyRecord): Promise<AnyRecord> {
    this.uniqueKey(args['where'], 'delete');
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const where = this.where(sql, t, args['where'])!;
      // RETURNING runs before ON DELETE CASCADE removes the links, so they're still there.
      const links = this.joinColumns(sql, [...this.tbl.joins.keys()]);
      const [row] = (
        await this.exec(
          sql`delete from ${sql.raw(q(this.tbl.table))} where ${where} returning *${links.length ? sql`, ${sql.join(links, sql`, `)}` : sql``}`,
        )
      ).rows;
      if (!row) throw new HttpError(404, `${this.name} not found`);
      return this.project(this.fromRaw(t, row), this.projection(args));
    });
  }

  async deleteMany(args: AnyRecord = {}): Promise<{ count: number }> {
    const { t, sql } = await this.ready(args['where']);
    return this.tbl.guard(async () => {
      const where = this.where(sql, t, args['where']) ?? sql`true`;
      const result = await this.tbl
        .client()
        .execute(sql`delete from ${sql.raw(q(this.tbl.table))} where ${where}`);
      return { count: result.rowCount ?? 0 };
    });
  }
}

/** An include value: `true`, or its options. */
function relArgs(arg: unknown): AnyRecord {
  return isPlainObject(arg) ? arg : {};
}

/** The defineTable runtime of a model `include` reaches, by name. */
function runtimeOf(name: string, from: string): TableRuntime {
  const runtime = getRegisteredModel(name)?.tableRuntime?.() as TableRuntime | undefined;
  if (!runtime) {
    throw new Error(
      getRegisteredModel(name)
        ? `[EFC] ${from}: include needs ${name} to be a defineTable model`
        : `[EFC] ${from}: "${name}" is not defined — import that model before including it`,
    );
  }
  return runtime;
}

const JSON_OPS = new Set([
  'path',
  'equals',
  'not',
  'string_contains',
  'string_starts_with',
  'string_ends_with',
  'array_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'mode',
]);

/**
 * A PostgreSQL-native model in Prisma's vocabulary. Types are inferred from the schema;
 * see `TableModel`. Fails at first use, with an `[EFC]` error, on a MongoDB connection.
 */
export function createTable(name: string, schema: TableSchema, options: TableOptions = {}) {
  // Schema errors surface at definition time; the runtime (Drizzle table) on first use.
  normalizeSchema(schema, 'table', name);
  for (const [rel, def] of Object.entries(options.relations ?? {})) {
    const where = `[EFC] ${name}.relations.${rel}`;
    if (rel in schema) throw new Error(`${where}: a field already has this name`);
    if (!def || (def.hasMany === undefined) === (def.hasOne === undefined)) {
      throw new Error(`${where}: give either hasMany or hasOne (a model name)`);
    }
    if (typeof def.foreignKey !== 'string') {
      throw new Error(
        `${where}: foreignKey must name the ${def.hasMany ?? def.hasOne} field that references ${name}`,
      );
    }
  }
  let runtime: TableRuntime | undefined;
  const rt = (): TableRuntime => {
    const engine = getDbEngine();
    if (engine !== 'postgresql') {
      throw new Error(
        `[EFC] ${name} is a PostgreSQL table (defineTable) but the app is connected to MongoDB — check DATABASE_URL / config.database, or use defineModel for a model that runs on both`,
      );
    }
    return (runtime ??= new TableRuntime(name, schema, options));
  };
  const call = <R>(fn: (r: TableRuntime) => Promise<R>): Promise<R> =>
    Promise.resolve().then(() => fn(rt()));

  const model = {
    name,
    findMany: (args?: AnyRecord) => call((r) => r.findMany(args)),
    findFirst: (args?: AnyRecord) => call((r) => r.findFirst(args)),
    findFirstOrThrow: (args?: AnyRecord) => call((r) => r.orThrow(r.findFirst(args))),
    findUnique: (args: AnyRecord) => call((r) => r.findUnique(args)),
    findUniqueOrThrow: (args: AnyRecord) => call((r) => r.orThrow(r.findUnique(args))),
    count: (args?: AnyRecord) => call((r) => r.count(args)),
    aggregate: (args?: AnyRecord) => call((r) => r.aggregate(args)),
    groupBy: (args: AnyRecord) => call((r) => r.groupBy(args)),
    create: (args: AnyRecord) => call((r) => r.withInclude(args, (a) => r.createNested(a))),
    createMany: (args: AnyRecord) =>
      call((r) => (r.noNested(args?.['data'], 'createMany'), r.createMany(args, false))),
    createManyAndReturn: (args: AnyRecord) =>
      call((r) => (r.noNested(args?.['data'], 'createMany'), r.createMany(args, true))),
    update: (args: AnyRecord) => call((r) => r.withInclude(args, (a) => r.updateNested(a))),
    updateMany: (args: AnyRecord) =>
      call((r) => (r.noNested(args?.['data'], 'updateMany'), r.updateMany(args, false))),
    updateManyAndReturn: (args: AnyRecord) =>
      call((r) => (r.noNested(args?.['data'], 'updateMany'), r.updateMany(args, true))),
    upsert: (args: AnyRecord) => call((r) => r.withInclude(args, (a) => r.upsertNested(a))),
    delete: (args: AnyRecord) => call((r) => r.deleteWithInclude(args)),
    deleteMany: (args?: AnyRecord) => call((r) => r.deleteMany(args)),
    raw: () => call(async (r) => (await r.tbl.compile()).t),
    sync: (opts?: { dryRun?: boolean }) => call((r) => r.tbl.reconcile(opts?.dryRun ?? false)),
    drop: () => call((r) => r.tbl.drop()),
  };
  traceOps(
    name,
    model,
    Object.keys(model).filter((op) => !['name', 'raw', 'sync', 'drop'].includes(op)),
  );
  registerModel({
    name,
    sync: model.sync,
    plan: (opts) => call((r) => r.tbl.plan(opts)),
    drop: model.drop,
    findByIds: (ids) => model.findMany({ where: { id: { in: ids } } }),
    pgTarget: () => ({ table: rt().tbl.table, idKind: rt().tbl.idKind }),
    tableRuntime: () => rt(),
  });
  return model;
}

/**
 * Defines a PostgreSQL-native model with Prisma's query vocabulary — `findMany`,
 * `findUnique`, `upsert`, `groupBy`, `aggregate` — and SQL types (`integer`, `bigint`,
 * `decimal`, `varchar`, native arrays and enums, serial ids). Record, input, filter and
 * result types are inferred from the schema. Throws at first use on a MongoDB connection.
 */
export function defineTable<const S extends TableSchema, const O extends TableOptions = object>(
  name: string,
  schema: S,
  options?: O,
): TableModel<S, O> {
  return createTable(name, schema, options ?? {}) as unknown as TableModel<S, O>;
}
