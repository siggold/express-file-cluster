/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle is an optional peer, loaded dynamically */
// The PostgreSQL table behind a model: columns, the Drizzle table, schema sync, record
// conversion, insert preparation, validation and error mapping. Shared by both query
// layers on top of it — defineModel's MongoDB-style API (pg-model.ts) and defineTable's
// Prisma-style API (table-model.ts) — so the same table reads and writes the same records.
import { randomUUID } from 'node:crypto';
import type { ModelOptions, ReferentialAction, TableOptions } from '../types.js';
import { HttpError } from '../errors.js';
import {
  applyDefaults,
  ModelValidationError,
  refFields,
  sequenceFields,
  timestampFields,
  validateTree,
  type AnyFieldDefinition,
  type FieldIssue,
  type FieldNode,
  type ScalarType,
  type SchemaTree,
} from './schema.js';
import {
  currentTx,
  getRegisteredModel,
  isAutoSync,
  isSyncSuppressed,
  registeredModels,
  type PlanOptions,
  type PlanStep,
} from './engine.js';
import { getOrm, getPool } from './postgres.js';
import { getLogger } from '../logger.js';

type AnyRecord = Record<string, unknown>;

interface Drizzle {
  sql: any;
  pgCore: any;
}

let drizzlePromise: Promise<Drizzle> | undefined;

export function loadDrizzle(): Promise<Drizzle> {
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

export const snakeCase = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const sequenceName = (key: string) => `efc_seq_${key.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()}`;
const literal = (v: string | number) =>
  typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

// Tables whose sync is running in this process, so a foreign key to one of them can wait
// for it instead of syncing it again (A ↔ B references would otherwise recurse).
const syncing = new Map<string, Promise<unknown>>();

const ACTION_SQL: Record<ReferentialAction, string> = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
};
// pg_constraint.confdeltype
const ACTION_CODE: Record<ReferentialAction, string> = {
  restrict: 'r',
  cascade: 'c',
  setNull: 'n',
};
// The column kind (and the field type to declare) a reference to each id strategy needs.
const ID_COLUMN = {
  uuid: { kind: 'uuid', type: 'uuid' },
  serial: { kind: 'integer', type: 'integer' },
  bigserial: { kind: 'bigint', type: 'bigint' },
} as const;

/** The model owning a table, for messages. */
const modelOfTable = (table: string) =>
  registeredModels().find((m) => {
    try {
      return m.pgTarget?.().table === table;
    } catch {
      return false;
    }
  })?.name ?? table;

// ── Columns ──────────────────────────────────────────────────────────────────

export type ScalarKind =
  | 'text'
  | 'varchar'
  | 'double'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'boolean'
  | 'timestamptz'
  | 'uuid'
  | 'enum';
export type ColumnKind = ScalarKind | 'jsonb' | 'array';

export interface ColumnSpec {
  /** Record key. */
  field: string;
  /** Database column name. */
  column: string;
  kind: ColumnKind;
  /** Type in DDL (`varchar(80)`, `integer[]`, `"orders_status_enum"`). */
  ddl: string;
  /** The same type as `format_type()` prints it, to compare with the live table. */
  formatted: string;
  /** Element kind of a native array column. */
  item?: ScalarKind;
  /** Schema node (absent for id and timestamps). */
  node?: FieldNode;
  /** `bigint` columns: JS `bigint` values, or `number` (sequences, defineModel). */
  bigintAs?: 'bigint' | 'number';
  length?: number;
  precision?: number;
  scale?: number;
  enumType?: string;
  enumValues?: string[];
}

/** A many-to-many `ref` array on defineTable, stored in a join table instead of a column. */
export interface JoinSpec {
  field: string;
  /** The join table: `<table>_<column>`, holding (owner_id, ref_id, position). */
  table: string;
  /** Where the array lived before it had a join table (backfilled from on first sync). */
  legacyColumn: string;
  target: string;
  /** Element kind: the target's id type. */
  item: 'uuid' | 'integer' | 'bigint';
  /** Array type of the ids (`uuid[]`, `integer[]`, `bigint[]`). */
  ddl: string;
  node: FieldNode;
}

type ScalarSpec = Pick<
  ColumnSpec,
  'kind' | 'ddl' | 'formatted' | 'length' | 'precision' | 'scale' | 'bigintAs'
>;

function scalarSpec(type: ScalarType, def: AnyFieldDefinition, native: boolean): ScalarSpec {
  switch (type) {
    case 'string':
      if (native && def.maxLength !== undefined) {
        return {
          kind: 'varchar',
          ddl: `varchar(${def.maxLength})`,
          formatted: `character varying(${def.maxLength})`,
          length: def.maxLength,
        };
      }
      return { kind: 'text', ddl: 'text', formatted: 'text' };
    case 'number':
      return { kind: 'double', ddl: 'double precision', formatted: 'double precision' };
    case 'integer':
      return { kind: 'integer', ddl: 'integer', formatted: 'integer' };
    case 'bigint':
      return { kind: 'bigint', ddl: 'bigint', formatted: 'bigint', bigintAs: 'bigint' };
    case 'decimal': {
      if (def.precision === undefined)
        return { kind: 'numeric', ddl: 'numeric', formatted: 'numeric' };
      const t = `numeric(${def.precision},${def.scale ?? 0})`;
      return {
        kind: 'numeric',
        ddl: t,
        formatted: t,
        precision: def.precision,
        scale: def.scale ?? 0,
      };
    }
    case 'boolean':
      return { kind: 'boolean', ddl: 'boolean', formatted: 'boolean' };
    case 'date':
      return { kind: 'timestamptz', ddl: 'timestamptz', formatted: 'timestamp with time zone' };
    case 'objectId':
    case 'uuid':
      return { kind: 'uuid', ddl: 'uuid', formatted: 'uuid' };
  }
}

export interface PgTableConfig {
  /** defineTable: SQL-native types, native arrays, varchar, enums, naming, id strategies. */
  native: boolean;
  /** Which API defined it, for messages. */
  api: 'defineModel' | 'defineTable';
}

export type IdKind = 'uuid' | 'serial' | 'bigserial';

export type PgTable = ReturnType<typeof pgTable>;

export function pgTable(
  name: string,
  tree: SchemaTree,
  options: ModelOptions & TableOptions,
  config: PgTableConfig,
) {
  const snake = config.native && options.naming === 'snake_case';
  const table = options.collection ?? tableNameFor(snake ? snakeCase(name) : name);
  const columnName = (field: string, def?: AnyFieldDefinition) =>
    def?.column ?? (snake ? snakeCase(field) : field);
  const idKind: IdKind = (config.native && options.id) || 'uuid';
  if (tree['id']) throw new Error(`[EFC] ${name}: "id" is the primary key — don't declare it`);

  const ts = timestampFields(options);
  const sequences = sequenceFields(name, tree);
  const sequenceKeys = new Map(sequences.map((s) => [s.path, s.key]));
  const refs = refFields(tree);

  const columns = new Map<string, ColumnSpec>();
  const joins = new Map<string, JoinSpec>();
  const idSpec: ColumnSpec =
    idKind === 'uuid'
      ? { field: 'id', column: 'id', kind: 'uuid', ddl: 'uuid', formatted: 'uuid' }
      : idKind === 'serial'
        ? { field: 'id', column: 'id', kind: 'integer', ddl: 'integer', formatted: 'integer' }
        : {
            field: 'id',
            column: 'id',
            kind: 'bigint',
            ddl: 'bigint',
            formatted: 'bigint',
            bigintAs: 'bigint',
          };
  columns.set('id', idSpec);

  for (const [field, node] of Object.entries(tree)) {
    const column = columnName(field, node.def);
    const base = { field, column, node };
    if (sequenceKeys.has(field)) {
      columns.set(field, {
        ...base,
        kind: 'bigint',
        ddl: 'bigint',
        formatted: 'bigint',
        bigintAs: 'number',
      });
    } else if (node.kind === 'scalar') {
      if (config.native && node.def.nativeEnum && node.def.enum) {
        const enumType = `${table}_${column}_enum`;
        columns.set(field, {
          ...base,
          kind: 'enum',
          ddl: q(enumType),
          formatted: /^[a-z_][a-z0-9_]*$/.test(enumType) ? enumType : q(enumType),
          enumType,
          enumValues: node.def.enum.map(String),
        });
      } else {
        columns.set(field, { ...base, ...scalarSpec(node.type, node.def, config.native) });
      }
    } else if (
      config.native &&
      node.kind === 'array' &&
      node.item.kind === 'scalar' &&
      node.def.ref !== undefined
    ) {
      // Many-to-many: a join table, not a column.
      const item = scalarSpec(node.item.type, node.item.def, false).kind as JoinSpec['item'];
      joins.set(field, {
        field,
        table: `${table}_${column}`,
        legacyColumn: column,
        target: node.def.ref,
        item,
        ddl: `${item}[]`,
        node,
      });
    } else if (config.native && node.kind === 'array' && node.item.kind === 'scalar') {
      // Items are plain scalars: no varchar length, no enum type.
      const item = scalarSpec(node.item.type, node.item.def, false);
      columns.set(field, {
        ...base,
        ...item,
        kind: 'array',
        item: item.kind as ScalarKind,
        ddl: `${item.ddl}[]`,
        formatted: `${item.formatted}[]`,
      });
    } else {
      columns.set(field, { ...base, kind: 'jsonb', ddl: 'jsonb', formatted: 'jsonb' });
    }
  }
  for (const field of [ts.createdAt, ts.updatedAt]) {
    if (field) {
      columns.set(field, {
        field,
        column: columnName(field),
        kind: 'timestamptz',
        ddl: 'timestamptz',
        formatted: 'timestamp with time zone',
      });
    }
  }
  const byColumn = new Map([...columns.values()].map((c) => [c.column, c]));

  // ── Drizzle table ──────────────────────────────────────────────────────────

  const builder = (pgCore: any, kind: ScalarKind, spec: ColumnSpec) => {
    const c = spec.column;
    switch (kind) {
      case 'varchar':
        return pgCore.varchar(c, { length: spec.length });
      case 'double':
        return pgCore.doublePrecision(c);
      case 'integer':
        return pgCore.integer(c);
      case 'bigint':
        return pgCore.bigint(c, { mode: spec.bigintAs ?? 'bigint' });
      case 'numeric':
        return pgCore.numeric(
          c,
          spec.precision !== undefined ? { precision: spec.precision, scale: spec.scale } : {},
        );
      case 'boolean':
        return pgCore.boolean(c);
      case 'timestamptz':
        return pgCore.timestamp(c, { withTimezone: true, mode: 'date' });
      case 'uuid':
        return pgCore.uuid(c);
      default:
        return pgCore.text(c); // text, enum (PostgreSQL casts parameters to the enum type)
    }
  };

  let compiled: Promise<{ t: any; sql: any }> | undefined;
  const compile = () =>
    (compiled ??= loadDrizzle().then(({ sql, pgCore }) => {
      const cols: AnyRecord = {};
      for (const [field, spec] of columns) {
        let c: any;
        if (spec.kind === 'jsonb') c = pgCore.jsonb(spec.column);
        else if (spec.kind === 'array') c = builder(pgCore, spec.item!, spec).array();
        else c = builder(pgCore, spec.kind, spec);
        if (field === 'id') {
          c =
            idKind === 'uuid'
              ? c.primaryKey().defaultRandom()
              : c.primaryKey().generatedByDefaultAsIdentity();
        }
        cols[field] = c;
      }
      return { t: pgCore.pgTable(table, cols), sql };
    }));

  // Like MongoDB creating collections and indexes on first use: the first query through
  // this model reconciles its table (unless autoSync is off). Memoised per process; a
  // failure is retried on the next use instead of being cached.
  let synced: Promise<void> | undefined;
  const ready = async () => {
    const result = await compile();
    if (isAutoSync()) {
      synced ??= reconcile(false).then(
        (changes) => {
          if (changes.length)
            getLogger().info({ table, changes: changes.length }, `Synced table ${table}`);
        },
        (err: unknown) => {
          synced = undefined;
          throw err;
        },
      );
      await synced;
    }
    return result;
  };

  const client = () => {
    const tx = currentTx();
    return tx?.engine === 'postgresql' ? tx.tx : getOrm();
  };

  const columnFor = (t: any, field: string) => {
    if (!columns.has(field))
      throw new ModelValidationError(name, [{ path: field, message: 'unknown field' }]);
    return t[field];
  };

  // ── Values in and out ──────────────────────────────────────────────────────

  const scalarToDb = (kind: ScalarKind | undefined, spec: ColumnSpec, v: unknown): unknown => {
    if (v == null) return v;
    if (kind === 'timestamptz') return v instanceof Date ? v : new Date(v as string);
    if (kind === 'bigint')
      return spec.bigintAs === 'number' ? Number(v) : BigInt(v as bigint | number | string);
    if (kind === 'numeric') return String(v);
    return v;
  };

  /** A record value → what the Drizzle column takes. */
  const toDb = (field: string, value: unknown): unknown => {
    const spec = columns.get(field);
    if (!spec || value == null) return value;
    if (spec.kind === 'array') {
      return Array.isArray(value) ? value.map((v) => scalarToDb(spec.item, spec, v)) : value;
    }
    if (spec.kind === 'jsonb') return value;
    return scalarToDb(spec.kind, spec, value);
  };

  // jsonb keeps dates as ISO strings; turn the ones the schema declares back into Dates,
  // as MongoDB returns them.
  const revive = (node: FieldNode, value: unknown): unknown => {
    if (value == null) return value;
    if (node.kind === 'scalar') {
      if (node.type === 'date' && typeof value === 'string') return new Date(value);
      return value;
    }
    if (node.kind === 'array' && Array.isArray(value))
      return value.map((v) => revive(node.item, v));
    if (node.kind === 'object' && typeof value === 'object' && !Array.isArray(value)) {
      const out: AnyRecord = { ...(value as AnyRecord) };
      for (const [k, child] of Object.entries(node.fields)) {
        if (out[k] !== undefined) out[k] = revive(child, out[k]);
      }
      return out;
    }
    return value;
  };
  const hasNestedDate = (node: FieldNode): boolean =>
    node.kind === 'scalar'
      ? node.type === 'date'
      : node.kind === 'array'
        ? hasNestedDate(node.item)
        : node.kind === 'object' && Object.values(node.fields).some(hasNestedDate);
  const datedJson = [...columns.values()].filter(
    (c) => c.kind === 'jsonb' && c.node && hasNestedDate(c.node),
  );
  const bigintCols = [...columns.values()].filter(
    (c) =>
      (c.kind === 'bigint' && c.bigintAs === 'bigint') ||
      (c.kind === 'array' && c.item === 'bigint'),
  );

  /** A Drizzle row (keyed by field) → a record: NULLs dropped, so unset fields are absent. */
  const fromRow = (row: AnyRecord): AnyRecord => {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
    for (const c of datedJson)
      if (out[c.field] !== undefined) out[c.field] = revive(c.node!, out[c.field]);
    for (const c of bigintCols) {
      const v = out[c.field];
      if (typeof v === 'string' || typeof v === 'number') out[c.field] = BigInt(v);
      else if (Array.isArray(v)) out[c.field] = v.map((x) => (x == null ? x : BigInt(x as string)));
    }
    return out;
  };

  /** A raw SQL row (keyed by column) → a record. */
  const fromRawRow = (row: AnyRecord): AnyRecord => {
    const keyed: AnyRecord = {};
    for (const [col, v] of Object.entries(row)) {
      const spec = byColumn.get(col);
      if (!spec) continue;
      keyed[spec.field] =
        v != null && spec.kind === 'timestamptz' && !(v instanceof Date)
          ? new Date(v as string)
          : v;
    }
    return fromRow(keyed);
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
    await validateTree(checkTree, data, issues, partial);
    if (issues.length) throw new ModelValidationError(name, issues);
  };

  // Undeclared fields are dropped silently on every write (mongoose's strict mode).
  const known = (data: AnyRecord): AnyRecord =>
    Object.fromEntries(
      Object.entries(data).filter(([k]) => {
        const top = k.split('.')[0]!;
        return columns.has(top) || joins.has(top);
      }),
    );

  const prepareInsert = async (input: AnyRecord): Promise<AnyRecord> => {
    const { id, ...rest } = known(input);
    for (const f of [ts.createdAt, ts.updatedAt]) if (f) delete rest[f];
    const data = applyDefaults(tree, rest, randomUUID);
    await validate(data, false);
    const now = new Date();
    if (ts.createdAt) data[ts.createdAt] = now;
    if (ts.updatedAt) data[ts.updatedAt] = now;
    if (id !== undefined) data['id'] = id;
    for (const [k, v] of Object.entries(data)) data[k] = toDb(k, v);
    return data;
  };

  const fieldOfColumn = (column: string) => byColumn.get(column)?.field ?? column;

  /** Maps PostgreSQL errors to EFC's: 409 duplicates, 400 validation, a hint for missing tables. */
  const guard = async <R>(fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn();
    } catch (err) {
      const e =
        (err as { cause?: { code?: string; detail?: string; column?: string; table?: string } })
          .cause ?? (err as { code?: string; detail?: string; column?: string; table?: string });
      if (e?.code === '42P01') {
        throw new Error(
          `[EFC] ${name}: table "${table}" does not exist — autoSync is off, so create it with a migration (Model.sync() / efc db sync)`,
        );
      }
      if (e?.code === '23505') {
        const cols = /\(([^)]+)\)=/.exec(e.detail ?? '')?.[1] ?? 'field';
        const fields = cols
          .split(',')
          .map((c) => fieldOfColumn(c.trim().replace(/"/g, '')))
          .join(', ');
        throw new HttpError(409, `${name} with this ${fields} already exists`);
      }
      // 23503 foreign_key_violation; 23001 restrict_violation (ON DELETE RESTRICT).
      if (e?.code === '23503' || e?.code === '23001') {
        const ref = /Key \(([^)]+)\)=\([^)]*\) is not present in table "([^"]+)"/.exec(
          e.detail ?? '',
        );
        if (ref) {
          throw new ModelValidationError(name, [
            {
              // In a join table: the many-to-many field it backs.
              path: joinByTable.get(e.table ?? '') ?? fieldOfColumn(ref[1]!.replace(/"/g, '')),
              message: `${modelOfTable(ref[2]!)} not found`,
            },
          ]);
        }
        const by = /is (?:still )?referenced from table "([^"]+)"/.exec(e.detail ?? '')?.[1];
        throw new HttpError(
          409,
          `${name} is still referenced${by ? ` by ${modelOfTable(by)}` : ''} — delete or reassign those records first`,
        );
      }
      if (e?.code === '23502')
        throw new ModelValidationError(name, [
          { path: fieldOfColumn(e.column ?? ''), message: 'is required' },
        ]);
      if (e?.code === '22P02' || e?.code === '22003' || e?.code === '23514')
        throw new ModelValidationError(name, [{ path: '', message: 'invalid value' }]);
      throw err;
    }
  };

  // ── Schema reconciliation ──────────────────────────────────────────────────
  // Brings the table in line with the model the way MongoDB "just works" when a schema
  // changes: create what's missing, convert changed column types, relax constraints the
  // model no longer asks for, rebuild enum checks, drop indexes EFC created that the
  // model no longer declares. Never drops a column or a row. Validation (required,
  // enum, ...) stays in the model, as on MongoDB — the database only keeps types,
  // uniqueness and enum checks, so editing a model can't strand existing rows.

  const JSONB_TO_ARRAY = 'efc_jsonb_text_array';
  const jsonbToArrayFn = `CREATE OR REPLACE FUNCTION ${JSONB_TO_ARRAY}(j jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN j IS NULL OR jsonb_typeof(j) = 'null' THEN NULL WHEN jsonb_typeof(j) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(j)) ELSE ARRAY[j #>> '{}'] END $$`;

  // USING expression converting an existing column to the model's type.
  const castExpr = (spec: ColumnSpec, from: string): string => {
    const c = q(spec.column);
    if (spec.kind === 'jsonb') return `to_jsonb(${c})`;
    if (spec.kind === 'array') {
      if (from === 'jsonb') return `${JSONB_TO_ARRAY}(${c})::${spec.ddl}`;
      if (from.endsWith('[]')) return `${c}::${spec.ddl}`;
      return `CASE WHEN ${c} IS NULL THEN NULL ELSE ARRAY[${c}::text]::${spec.ddl} END`;
    }
    const scalar = from === 'jsonb' ? `(${c} #>> '{}')` : c;
    if (spec.kind === 'enum') return `${scalar}::text::${spec.ddl}`;
    if (spec.kind === 'bigint' || spec.kind === 'integer') {
      return `round(${scalar}::numeric)::${spec.ddl}`;
    }
    return `${scalar}::${spec.ddl}`;
  };

  // varchar never shrinks (and a text column isn't narrowed to varchar): rows could stop fitting.
  const needsTypeChange = (spec: ColumnSpec, existing: string): boolean => {
    if (existing === spec.formatted) return false;
    if (spec.kind === 'varchar') {
      if (existing === 'text') return false;
      const m = /^character varying\((\d+)\)$/.exec(existing);
      if (m && Number(m[1]) >= spec.length!) return false;
    }
    return true;
  };

  const enumCheck = (column: string) => `${table}_${column}_enum`;

  // ── Foreign keys (defineTable refs) ────────────────────────────────────────

  interface ForeignKey {
    field: string;
    /** The table holding the constraint: this one, or one of its join tables. */
    onTable: string;
    column: string;
    name: string;
    target: string;
    targetTable: string;
    action: ReferentialAction;
  }

  const fkName = (column: string) => `${table}_${column}_fkey`;
  const isForeignKey = (spec: ColumnSpec) =>
    config.native && spec.node?.kind === 'scalar' && spec.node.def.ref !== undefined;

  /** A `ref`'s target table, checked against the field's id type. */
  function resolveTarget(field: string, targetName: string, kind: string, many: boolean) {
    const target =
      targetName === name ? { table, idKind } : getRegisteredModel(targetName)?.pgTarget?.();
    if (!target) {
      throw new Error(
        `[EFC] ${name}.${field} references "${targetName}", which is not defined — import that model before using ${name}`,
      );
    }
    const want = ID_COLUMN[target.idKind];
    if (kind !== want.kind) {
      const hint = many
        ? `{ type: 'array', of: '${want.type}', ref: '${targetName}' }`
        : `{ type: '${want.type}', ref: '${targetName}' }`;
      throw new Error(
        `[EFC] ${name}.${field} references ${targetName}, whose id is ${want.type} (id: '${target.idKind}') — declare it ${hint}`,
      );
    }
    return target;
  }

  /**
   * The foreign keys the model declares, resolved against their target models: one per
   * scalar ref, and two per join table (to this table and to the target, both cascading).
   */
  function foreignKeys(): ForeignKey[] {
    const out: ForeignKey[] = [];
    for (const spec of columns.values()) {
      if (!isForeignKey(spec)) continue;
      const def = spec.node!.def;
      const target = resolveTarget(spec.field, def.ref!, spec.kind, false);
      out.push({
        field: spec.field,
        onTable: table,
        column: spec.column,
        name: fkName(spec.column),
        target: def.ref!,
        targetTable: target.table,
        action: def.onDelete ?? 'restrict',
      });
    }
    for (const join of joins.values()) {
      const target = resolveTarget(join.field, join.target, join.item, true);
      const base = { field: join.field, onTable: join.table, action: 'cascade' as const };
      out.push(
        {
          ...base,
          column: 'owner_id',
          name: `${join.table}_owner_id_fkey`,
          target: name,
          targetTable: table,
        },
        {
          ...base,
          column: 'ref_id',
          name: `${join.table}_ref_id_fkey`,
          target: join.target,
          targetTable: target.table,
        },
      );
    }
    return out;
  }

  const joinByTable = new Map([...joins.values()].map((j) => [j.table, j.field]));
  const managedIndexName = /_(key|idx)$/;

  function desiredIndexes(): Map<string, string> {
    const out = new Map<string, string>();
    for (const spec of columns.values()) {
      const def = spec.node?.def;
      if (!def) continue;
      const col = spec.column;
      if (def.unique) {
        out.set(
          `${table}_${col}_key`,
          `CREATE UNIQUE INDEX ${q(`${table}_${col}_key`)} ON ${q(table)} (${q(col)})`,
        );
      } else if (def.index || (isForeignKey(spec) && def.index !== false)) {
        // Foreign key columns are indexed (joins, ON DELETE lookups) unless index: false.
        out.set(
          `${table}_${col}_idx`,
          `CREATE INDEX ${q(`${table}_${col}_idx`)} ON ${q(table)} (${q(col)})`,
        );
      }
    }
    for (const idx of options.indexes ?? []) {
      const fields = Object.entries(idx.fields).map(
        ([f, d]) => [columns.get(f)?.column ?? f, d] as const,
      );
      if (idx.expireAfterSeconds !== undefined) {
        throw new Error(`[EFC] ${name}: TTL indexes (expireAfterSeconds) are MongoDB-only`);
      }
      const idxName =
        idx.name ?? `${table}_${fields.map(([f]) => f).join('_')}_${idx.unique ? 'key' : 'idx'}`;
      if (fields.some(([, d]) => d === 'text')) {
        const doc = fields.map(([f]) => `coalesce(${q(f)}::text, '')`).join(` || ' ' || `);
        out.set(
          idxName,
          `CREATE INDEX ${q(idxName)} ON ${q(table)} USING gin (to_tsvector('simple', ${doc}))`,
        );
      } else {
        const cols = fields.map(([f, d]) => `${q(f)} ${d === -1 ? 'DESC' : 'ASC'}`).join(', ');
        out.set(
          idxName,
          `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idxName)} ON ${q(table)} (${cols})`,
        );
      }
    }
    return out;
  }

  const tableExists = async (t: string) =>
    (
      await getPool().query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = $1 AND n.nspname = current_schema() AND c.relkind IN ('r', 'p')`,
        [t],
      )
    ).rowCount! > 0;

  /**
   * Syncs the table. A foreign key needs its target table, so missing targets are synced
   * first; one whose sync is already running here (A ↔ B references) is skipped this pass
   * and added by a second pass once that sync finishes.
   */
  async function reconcile(dryRun: boolean): Promise<string[]> {
    if (isSyncSuppressed()) return [];
    const fks = foreignKeys();
    if (dryRun) return statements(await reconcileTable({ dryRun: true }, fks, new Set()));
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const prev = syncing.get(table);
    syncing.set(table, mine);
    try {
      const deferred = new Set<string>();
      // First used inside a transaction: adding a foreign key locks the referenced table,
      // which that transaction may already have written to — the sync (on its own
      // connection) and the transaction would wait for each other forever. Create the
      // tables now; add the keys once the transaction has committed.
      const tx = currentTx();
      if (tx?.engine === 'postgresql' && fks.length) {
        for (const fk of fks) deferred.add(fk.name);
        tx.afterCommit.push(() => {
          reconcile(false).catch((err: unknown) =>
            getLogger().error({ err }, `${name}: adding foreign keys to "${table}" failed`),
          );
        });
      }
      for (const fk of fks) {
        if (deferred.has(fk.name)) continue;
        if (fk.targetTable === table || (await tableExists(fk.targetTable))) continue;
        const running = syncing.get(fk.targetTable);
        if (running) {
          deferred.add(fk.name);
          void running
            .then(() => reconcile(false))
            .catch((err: unknown) =>
              getLogger().error({ err }, `${name}: adding foreign keys to "${table}" failed`),
            );
        } else {
          await getRegisteredModel(fk.target)!.sync();
        }
      }
      return statements(await reconcileTable({ dryRun: false }, fks, deferred));
    } finally {
      release();
      if (syncing.get(table) === mine) {
        if (prev) syncing.set(table, prev);
        else syncing.delete(table);
      }
    }
  }

  const statements = (steps: PlanStep[]) => steps.filter((s) => !s.check).map((s) => s.sql);

  /**
   * The migration `efc db generate` writes for this table: what sync would do, plus the
   * explicit extras (`allowDrop`, `tighten`), each step with a best-effort reverse.
   */
  function plan(options: PlanOptions = {}): Promise<PlanStep[]> {
    return reconcileTable({ dryRun: true, plan: options }, foreignKeys(), new Set());
  }

  async function reconcileTable(
    mode: { dryRun: boolean; plan?: PlanOptions },
    fks: ForeignKey[],
    deferred: Set<string>,
  ): Promise<PlanStep[]> {
    const { dryRun } = mode;
    const generating = mode.plan !== undefined;
    const pool = getPool();
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      // Serialises concurrent syncs of this table (every cluster worker runs one on boot).
      await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`efc_sync:${table}`]);

      const existing = new Map<string, { type: string; nullable: boolean }>(
        (
          await conn.query<{ name: string; type: string; nullable: boolean }>(
            `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = $1 AND n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped`,
            [table],
          )
        ).rows.map((r) => [r.name, { type: r.type, nullable: r.nullable }]),
      );
      const checks = new Map<string, { def: string; valid: boolean }>(
        (
          await conn.query<{ name: string; def: string; valid: boolean }>(
            `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def, con.convalidated AS valid
             FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = $1 AND n.nspname = current_schema() AND con.contype = 'c'`,
            [table],
          )
        ).rows.map((r) => [r.name, { def: r.def, valid: r.valid }]),
      );
      const indexes = new Map(
        (
          await conn.query<{ name: string; def: string }>(
            `SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE tablename = $1 AND schemaname = current_schema()`,
            [table],
          )
        ).rows.map((r) => [r.name, r.def]),
      );

      const liveFks = new Map(
        (
          await conn.query<{
            name: string;
            target: string;
            action: string;
            valid: boolean;
            def: string;
          }>(
            `SELECT con.conname AS name, ft.relname AS target, con.confdeltype AS action, con.convalidated AS valid,
                    pg_get_constraintdef(con.oid) AS def
             FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class ft ON ft.oid = con.confrelid
             WHERE c.relname = ANY($1) AND n.nspname = current_schema() AND con.contype = 'f'`,
            [[table, ...joinByTable.keys()]],
          )
        ).rows.map((r) => [r.name, r]),
      );
      const liveJoinTables = new Set(
        (
          await conn.query<{ name: string }>(
            `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = ANY($1) AND n.nspname = current_schema() AND c.relkind IN ('r', 'p')`,
            [[...joinByTable.keys()]],
          )
        ).rows.map((r) => r.name),
      );

      const steps: PlanStep[] = [];
      const add = (sql: string, extra: Omit<Partial<PlanStep>, 'sql'> = {}) => {
        if (!steps.some((s) => s.sql === sql)) steps.push({ phase: 'main', ...extra, sql });
      };
      const columnExists = (column: string) =>
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${literal(table)} AND column_name = ${literal(column)}`;

      // Foreign keys on the model's fields that it no longer declares (or declares
      // differently) go first, before any column type change. Constraints on columns the
      // model doesn't declare are left alone.
      const wantedFks = new Map(fks.map((fk) => [fk.name, fk]));
      for (const [con, live] of liveFks) {
        const want = wantedFks.get(con);
        // Join tables are entirely EFC's.
        const ours =
          [...joinByTable.keys()].some((jt) => con.startsWith(`${jt}_`)) ||
          [...columns.values()].some((c) => c.field !== 'id' && fkName(c.column) === con);
        if (
          ours &&
          (!want || live.target !== want.targetTable || live.action !== ACTION_CODE[want.action])
        ) {
          const on = [...joinByTable.keys()].find((jt) => con.startsWith(`${jt}_`)) ?? table;
          add(`ALTER TABLE ${q(on)} DROP CONSTRAINT IF EXISTS ${q(con)}`, {
            down: `ALTER TABLE ${q(on)} ADD CONSTRAINT ${q(con)} ${live.def}`,
          });
          liveFks.delete(con);
        }
      }
      for (const { key } of sequences) {
        const seq = sequenceName(key);
        const found = await conn.query(
          `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'S' AND c.relname = $1 AND n.nspname = current_schema()`,
          [seq],
        );
        if (found.rowCount === 0)
          add(`CREATE SEQUENCE IF NOT EXISTS ${q(seq)}`, {
            down: `DROP SEQUENCE IF EXISTS ${q(seq)}`,
          });
      }

      // Native enum types: create, or add values the model gained. Values are never
      // removed (rows may hold them); the model rejects them on writes.
      const enumSpecs = [...columns.values()].filter((c) => c.kind === 'enum');
      if (enumSpecs.length) {
        const live = new Map<string, Set<string>>();
        for (const r of (
          await conn.query<{ type: string; label: string | null }>(
            `SELECT t.typname AS type, e.enumlabel AS label FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_enum e ON e.enumtypid = t.oid
             WHERE n.nspname = current_schema() AND t.typname = ANY($1)`,
            [enumSpecs.map((c) => c.enumType)],
          )
        ).rows) {
          const set = live.get(r.type) ?? new Set<string>();
          if (r.label !== null) set.add(r.label);
          live.set(r.type, set);
        }
        for (const spec of enumSpecs) {
          const have = live.get(spec.enumType!);
          if (!have) {
            add(`CREATE TYPE ${spec.ddl} AS ENUM (${spec.enumValues!.map(literal).join(', ')})`, {
              down: `DROP TYPE IF EXISTS ${spec.ddl}`,
              skipIf: `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema() AND t.typname = ${literal(spec.enumType!)}`,
            });
          } else {
            for (const v of spec.enumValues!) {
              if (!have.has(v)) add(`ALTER TYPE ${spec.ddl} ADD VALUE IF NOT EXISTS ${literal(v)}`);
            }
          }
        }
      }

      const columnSql = (spec: ColumnSpec) => {
        const seq = sequenceKeys.get(spec.field);
        return `${q(spec.column)} ${spec.ddl}${seq ? ` DEFAULT nextval('${sequenceName(seq)}')` : ''}`;
      };
      const idSql =
        idKind === 'uuid'
          ? `${q('id')} uuid PRIMARY KEY DEFAULT gen_random_uuid()`
          : `${q('id')} ${idSpec.ddl} GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
      const isRequired = (spec: ColumnSpec) =>
        spec.field !== 'id' && spec.node?.kind !== undefined && spec.node.def.required === true;

      if (existing.size === 0) {
        const defs = [...columns.values()].map((spec) =>
          spec.field === 'id' ? idSql : columnSql(spec),
        );
        add(`CREATE TABLE IF NOT EXISTS ${q(table)} (\n  ${defs.join(',\n  ')}\n)`, {
          down: `DROP TABLE IF EXISTS ${q(table)}`,
        });
      } else {
        // Renames first: `renamedFrom` moves the old column (and its data) to the new name
        // instead of adding an empty one beside it.
        for (const spec of columns.values()) {
          const old = spec.node?.def.renamedFrom;
          if (old === undefined || existing.has(spec.column)) continue;
          const oldColumn = columnName(old);
          const col = existing.get(oldColumn);
          if (!col) continue;
          add(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(oldColumn)} TO ${q(spec.column)}`, {
            down: `ALTER TABLE ${q(table)} RENAME COLUMN ${q(spec.column)} TO ${q(oldColumn)}`,
            skipIf: columnExists(spec.column),
          });
          existing.delete(oldColumn);
          existing.set(spec.column, col);
        }
        for (const spec of columns.values()) {
          const col = existing.get(spec.column);
          if (!col) {
            add(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${columnSql(spec)}`, {
              down: `ALTER TABLE ${q(table)} DROP COLUMN IF EXISTS ${q(spec.column)}`,
            });
          } else if (spec.field !== 'id' && needsTypeChange(spec, col.type)) {
            if (spec.kind === 'array' && col.type === 'jsonb') add(jsonbToArrayFn, { down: '' });
            const back =
              col.type === 'jsonb'
                ? `to_jsonb(${q(spec.column)})`
                : `${q(spec.column)}::${col.type}`;
            add(
              `ALTER TABLE ${q(table)} ALTER COLUMN ${q(spec.column)} TYPE ${spec.ddl} USING ${castExpr(spec, col.type)}`,
              {
                down: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(spec.column)} TYPE ${col.type} USING ${back}`,
                skipIf: `SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ${literal(table)} AND a.attname = ${literal(spec.column)} AND format_type(a.atttypid, a.atttypmod) = ${literal(spec.formatted)}`,
              },
            );
          }
        }
        // NOT NULL is the model's job (validation), as on MongoDB: relax any the model
        // doesn't ask for — left over from an older model, an earlier EFC version, or a
        // column it no longer declares — so dropping/loosening a field never breaks inserts.
        for (const [column, col] of existing) {
          const spec = byColumn.get(column);
          if (column !== 'id' && !col.nullable && !(spec && isRequired(spec))) {
            add(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} DROP NOT NULL`, {
              down: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} SET NOT NULL`,
            });
          }
        }
      }

      // Enum checks: one managed constraint per (non-native) enum field, rebuilt when the
      // values change. NOT VALID: like MongoDB, existing rows aren't re-validated.
      const wantedChecks = new Map<string, string>();
      for (const spec of columns.values()) {
        const def = spec.node?.def;
        if (spec.node?.kind === 'scalar' && def?.enum && spec.kind !== 'enum') {
          wantedChecks.set(
            enumCheck(spec.column),
            `CHECK (${q(spec.column)} IN (${def.enum.map(literal).join(', ')}))`,
          );
        }
      }
      for (const [con, { def }] of checks) {
        const legacy = con.endsWith('_check') && con.startsWith(`${table}_`); // inline CHECKs from older EFC
        const drop = () => {
          add(`ALTER TABLE ${q(table)} DROP CONSTRAINT IF EXISTS ${q(con)}`, {
            down: `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(con)} ${def}`,
          });
          checks.delete(con);
        };
        if (
          (con.endsWith('_enum') && con.startsWith(`${table}_`) && !wantedChecks.has(con)) ||
          legacy
        ) {
          drop();
        } else if (wantedChecks.has(con)) {
          const want = wantedChecks.get(con)!;
          // pg_get_constraintdef normalises the text; compare the value lists only.
          const values = (d: string) =>
            [...d.matchAll(/'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g)]
              .map((m) => m[1] ?? m[2])
              .sort()
              .join('|');
          if (values(def) !== values(want)) drop();
        }
      }
      for (const [con, def] of wantedChecks) {
        if (!checks.has(con))
          add(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(con)} ${def} NOT VALID`, {
            down: `ALTER TABLE ${q(table)} DROP CONSTRAINT IF EXISTS ${q(con)}`,
            skipIf: `SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ${literal(table)} AND con.conname = ${literal(con)}`,
          });
      }

      // Indexes: create declared ones, drop EFC-named ones the model no longer declares.
      const wantedIndexes = desiredIndexes();
      for (const [idx, def] of indexes) {
        if (
          idx !== `${table}_pkey` &&
          idx.startsWith(`${table}_`) &&
          managedIndexName.test(idx) &&
          !wantedIndexes.has(idx)
        ) {
          add(`DROP INDEX IF EXISTS ${q(idx)}`, { down: def });
        }
      }
      for (const [idx, create] of wantedIndexes)
        if (!indexes.has(idx))
          add(create.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS '), {
            down: `DROP INDEX IF EXISTS ${q(idx)}`,
          });

      // Join tables for many-to-many refs: created once, filled from the array column the
      // field used before (if any). That column is kept, as sync never drops columns.
      const ownerDdl = idSpec.ddl;
      for (const join of joins.values()) {
        if (liveJoinTables.has(join.table)) continue;
        const refDdl = join.item;
        add(
          `CREATE TABLE IF NOT EXISTS ${q(join.table)} (\n  ${q('owner_id')} ${ownerDdl} NOT NULL,\n  ${q('ref_id')} ${refDdl} NOT NULL,\n  ${q('position')} integer NOT NULL DEFAULT 0,\n  PRIMARY KEY (${q('owner_id')}, ${q('ref_id')})\n)`,
          { down: `DROP TABLE IF EXISTS ${q(join.table)}` },
        );
        add(
          `CREATE INDEX IF NOT EXISTS ${q(`${join.table}_ref_id_idx`)} ON ${q(join.table)} (${q('ref_id')})`,
          { down: '' }, // dropped with the table
        );
        const legacy = existing.get(join.legacyColumn)?.type;
        if (legacy === 'jsonb' || legacy?.endsWith('[]')) {
          const c = `o.${q(join.legacyColumn)}`;
          const items =
            legacy === 'jsonb'
              ? `jsonb_array_elements_text(CASE WHEN jsonb_typeof(${c}) = 'array' THEN ${c} ELSE '[]'::jsonb END)`
              : `unnest(${c}::text[])`;
          const valid =
            join.item === 'uuid'
              ? `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`
              : `'^-?[0-9]{1,18}$'`;
          add(
            `INSERT INTO ${q(join.table)} (${q('owner_id')}, ${q('ref_id')}, ${q('position')}) SELECT o.${q('id')}, x.v::${refDdl}, x.n FROM ${q(table)} o, ${items} WITH ORDINALITY AS x(v, n) WHERE x.v ~ ${valid} ON CONFLICT DO NOTHING`,
            { down: '' }, // the old column is kept
          );
        }
      }

      // `efc db generate` only, never automatic: changes that can fail on existing rows or
      // lose data. Each tightening is guarded by a check that names the offending rows.
      if (mode.plan?.tighten) {
        for (const spec of columns.values()) {
          if (!isRequired(spec) || existing.get(spec.column)?.nullable === false) continue;
          add(`SELECT count(*)::int AS n FROM ${q(table)} WHERE ${q(spec.column)} IS NULL`, {
            check: `${name}.${spec.field} is required, but %n row(s) of "${table}" have no value — fill them in, then run the migration again`,
          });
          add(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(spec.column)} SET NOT NULL`, {
            down: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(spec.column)} DROP NOT NULL`,
          });
        }
        for (const [con, def] of wantedChecks) {
          if (checks.get(con)?.valid) continue;
          const spec = byColumn.get(con.slice(table.length + 1, -'_enum'.length));
          const values = /IN \((.*)\)\)$/.exec(def)?.[1];
          if (spec && values) {
            add(
              `SELECT count(*)::int AS n FROM ${q(table)} WHERE ${q(spec.column)} IS NOT NULL AND ${q(spec.column)} NOT IN (${values})`,
              {
                check: `${name}.${spec.field}: %n row(s) of "${table}" hold a value outside its enum — fix them, then run the migration again`,
              },
            );
          }
          add(`ALTER TABLE ${q(table)} VALIDATE CONSTRAINT ${q(con)}`, { down: '' });
        }
      }
      if (mode.plan?.allowDrop) {
        for (const [column, col] of existing) {
          if (byColumn.has(column)) continue;
          add(`ALTER TABLE ${q(table)} DROP COLUMN IF EXISTS ${q(column)}`, {
            down: `ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(column)} ${col.type} -- data is not restored`,
          });
        }
      }

      // Added NOT VALID — instant, and existing rows can't fail the sync — then validated
      // after the commit, where orphaned rows only produce a warning. A generated
      // migration validates in the same run, behind an orphaned-rows check.
      const toValidate: ForeignKey[] = [];
      for (const fk of fks) {
        if (deferred.has(fk.name)) continue;
        const live = liveFks.get(fk.name);
        if (!live) {
          add(
            `ALTER TABLE ${q(fk.onTable)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${q(fk.column)}) REFERENCES ${q(fk.targetTable)} (${q('id')}) ON DELETE ${ACTION_SQL[fk.action]} NOT VALID`,
            {
              phase: 'fk',
              down: `ALTER TABLE ${q(fk.onTable)} DROP CONSTRAINT IF EXISTS ${q(fk.name)}`,
              skipIf: `SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ${literal(fk.onTable)} AND con.conname = ${literal(fk.name)}`,
            },
          );
        }
        if (!live?.valid) toValidate.push(fk);
      }
      const orphans = (fk: ForeignKey) =>
        `SELECT count(*)::int AS n FROM ${q(fk.onTable)} r WHERE ${q(fk.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(fk.targetTable)} t WHERE t.${q('id')} = r.${q(fk.column)})`;
      const validations = toValidate.map(
        (fk) => `ALTER TABLE ${q(fk.onTable)} VALIDATE CONSTRAINT ${q(fk.name)}`,
      );
      if (generating) {
        for (const [i, fk] of toValidate.entries()) {
          add(orphans(fk), {
            phase: 'fk',
            check: `${name}.${fk.field}: %n row(s) reference a missing ${fk.target} — fix them, then run the migration again`,
          });
          add(validations[i]!, { phase: 'fk', down: '' });
        }
      }

      if (!dryRun) {
        for (const { sql: stmt } of steps) {
          try {
            await conn.query(stmt);
          } catch (err) {
            throw new Error(
              `[EFC] ${name}: syncing table "${table}" failed on: ${stmt}\n  ${(err as Error).message}`,
            );
          }
        }
      }
      await conn.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      if (!dryRun) {
        for (const [i, fk] of toValidate.entries()) {
          try {
            await conn.query(validations[i]!);
          } catch {
            const n = await conn
              .query<{ n: number }>(orphans(fk))
              .then((r) => r.rows[0]?.n ?? '?')
              .catch(() => '?');
            getLogger().warn(
              { table, constraint: fk.name, orphans: Number(n) },
              `${name}.${fk.field}: ${n} row(s) reference a missing ${fk.target} — the foreign key applies to new writes; fix those rows, then run efc db sync to validate it`,
            );
          }
        }
      }
      return generating
        ? steps
        : [...steps, ...validations.map((sql) => ({ sql, phase: 'fk' as const }))];
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async function drop() {
    const { sql } = await compile();
    await client().execute(sql.raw(`DROP TABLE IF EXISTS ${q(table)}`));
  }

  return {
    name,
    table,
    tree,
    idKind,
    columns,
    joins,
    ts,
    sequenceKeys,
    refs,
    compile,
    ready,
    client,
    columnFor,
    toDb,
    fromRow,
    fromRawRow,
    validate,
    known,
    prepareInsert,
    guard,
    reconcile,
    plan,
    drop,
  };
}
