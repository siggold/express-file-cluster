import { randomBytes, randomUUID } from 'node:crypto';
import type {
  DefaultOperator,
  ModelSchema,
  ModelOptions,
  TableFieldDefinition,
  TableSchema,
  TableSchemaField,
} from '../types.js';
import { getCurrentUser } from '../context.js';
import { HttpError } from '../errors.js';

// ── Normalised schema tree ───────────────────────────────────────────────────
// The three accepted field syntaxes (FieldDefinition, nested-schema shorthand,
// [schema] tuple) collapse into one tree that the engine adapters walk. The tree
// covers defineTable's SQL types too; defineModel schemas just never contain them.

export type ScalarType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'uuid';

/** Every field definition the tree holds (a superset of the portable `FieldDefinition`). */
export type AnyFieldDefinition = TableFieldDefinition;

export type FieldNode =
  | { kind: 'scalar'; type: ScalarType; def: AnyFieldDefinition }
  | { kind: 'json'; def: AnyFieldDefinition } // untyped object / untyped array / json
  | { kind: 'object'; fields: SchemaTree; def: AnyFieldDefinition }
  | { kind: 'array'; item: FieldNode; def: AnyFieldDefinition };

export type SchemaTree = Record<string, FieldNode>;

/** Which model API a schema belongs to — it decides the field types allowed. */
export type SchemaMode = 'model' | 'table';

const MODEL_TYPES = new Set(['string', 'number', 'boolean', 'date', 'object', 'objectId', 'array']);
const TABLE_ONLY_TYPES = new Set(['integer', 'bigint', 'decimal', 'uuid', 'json']);
const TABLE_ONLY_OPTIONS = ['precision', 'scale', 'nativeEnum', 'column', 'onDelete'] as const;
const REFERENTIAL_ACTIONS = new Set(['restrict', 'cascade', 'setNull']);
const FOREIGN_KEY_TYPES = new Set(['objectId', 'uuid', 'integer', 'bigint']);

export function isFieldDefinition(value: unknown): value is AnyFieldDefinition {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (MODEL_TYPES.has(type) || TABLE_ONLY_TYPES.has(type));
}

const untyped = (): FieldNode => ({ kind: 'json', def: { type: 'object' } });

class SchemaBuilder {
  constructor(
    private readonly model: string,
    private readonly mode: SchemaMode,
  ) {}

  private fail(path: string, message: string): never {
    throw new Error(`[EFC] ${this.model}.${path}: ${message}`);
  }

  private checkType(type: string, path: string) {
    if (this.mode === 'model' && TABLE_ONLY_TYPES.has(type)) {
      this.fail(path, `type '${type}' is PostgreSQL-only — use defineTable, or a portable type`);
    }
  }

  private checkDefinition(def: AnyFieldDefinition, path: string, topLevel: boolean) {
    this.checkType(def.type, path);
    if (def.renamedFrom !== undefined && !topLevel) {
      this.fail(path, `'renamedFrom' only applies to top-level fields`);
    }
    if (this.mode === 'model') {
      for (const opt of TABLE_ONLY_OPTIONS) {
        if (def[opt] !== undefined) this.fail(path, `'${opt}' is a defineTable option`);
      }
      return;
    }
    if ((def.precision !== undefined || def.scale !== undefined) && def.type !== 'decimal') {
      this.fail(path, `'precision' / 'scale' only apply to decimal fields`);
    }
    if (def.scale !== undefined && def.precision === undefined) {
      this.fail(path, `'scale' needs 'precision'`);
    }
    if (def.nativeEnum && !(def.enum && def.enum.every((v) => typeof v === 'string'))) {
      this.fail(path, `'nativeEnum' needs a string 'enum'`);
    }
    if (def.column !== undefined && !topLevel) {
      this.fail(path, `'column' only applies to top-level fields`);
    }
    if (def.onDelete !== undefined) {
      if (def.ref === undefined) this.fail(path, `'onDelete' needs 'ref'`);
      if (!REFERENTIAL_ACTIONS.has(def.onDelete)) {
        this.fail(path, `onDelete must be 'restrict', 'cascade' or 'setNull'`);
      }
      if (def.onDelete === 'setNull' && def.required) {
        this.fail(path, `onDelete: 'setNull' can't clear a required field`);
      }
    }
    // A scalar ref is a foreign key, an array of refs a many-to-many join table: both
    // top-level and typed like the target's id.
    if (def.ref !== undefined) {
      const many = def.type === 'array';
      if (!topLevel) this.fail(path, `'ref' only applies to top-level fields`);
      if (!FOREIGN_KEY_TYPES.has(many ? String(def.of) : def.type)) {
        this.fail(
          path,
          many
            ? `a many-to-many 'ref' needs of: objectId, uuid, integer or bigint`
            : `'ref' needs an id type: objectId, uuid, integer or bigint`,
        );
      }
      if (many && def.onDelete !== undefined) {
        this.fail(
          path,
          `'onDelete' doesn't apply to many-to-many refs — links are always removed with either record`,
        );
      }
      if (many && (def.unique || def.index)) {
        this.fail(path, `many-to-many refs are indexed already; 'unique' / 'index' don't apply`);
      }
    }
  }

  private item(of: AnyFieldDefinition['of'], parent: AnyFieldDefinition, path: string): FieldNode {
    if (of === undefined) return untyped();
    if (typeof of === 'string') {
      this.checkType(of, path);
      if (of === 'object' || of === 'json') return untyped();
      const def: AnyFieldDefinition = {
        type: of,
        ...(parent.ref !== undefined && { ref: parent.ref }),
      };
      return { kind: 'scalar', type: of, def };
    }
    return { kind: 'object', fields: this.tree(of, `${path}.$`), def: { type: 'object' } };
  }

  field(field: TableSchemaField, path: string, topLevel: boolean): FieldNode {
    if (Array.isArray(field)) {
      const inner = (field as readonly TableSchema[])[0];
      return {
        kind: 'array',
        item: inner
          ? { kind: 'object', fields: this.tree(inner, `${path}.$`), def: { type: 'object' } }
          : untyped(),
        def: { type: 'array' },
      };
    }
    if (!isFieldDefinition(field)) {
      const type = (field as { type?: unknown }).type;
      if (typeof type === 'string') this.fail(path, `unknown field type '${type}'`);
      return {
        kind: 'object',
        fields: this.tree(field as TableSchema, path),
        def: { type: 'object' },
      };
    }
    const def = field;
    this.checkDefinition(def, path, topLevel);
    if (def.type === 'array') return { kind: 'array', item: this.item(def.of, def, path), def };
    if (def.type === 'object') {
      return def.fields
        ? { kind: 'object', fields: this.tree(def.fields, path), def }
        : { kind: 'json', def };
    }
    if (def.type === 'json') return { kind: 'json', def };
    return { kind: 'scalar', type: def.type, def };
  }

  tree(schema: TableSchema, prefix = ''): SchemaTree {
    const out: SchemaTree = {};
    for (const [key, field] of Object.entries(schema)) {
      out[key] = this.field(field, prefix ? `${prefix}.${key}` : key, prefix === '');
    }
    return out;
  }
}

/**
 * Normalises a schema. `model` mode (defineModel) rejects the PostgreSQL-only types and
 * options with an `[EFC]` error naming the field; `table` mode (defineTable) accepts them.
 */
export function normalizeSchema(
  schema: ModelSchema | TableSchema,
  mode: SchemaMode = 'model',
  model = 'Model',
): SchemaTree {
  return new SchemaBuilder(model, mode).tree(schema as TableSchema);
}

export function timestampFields(options: ModelOptions): { createdAt?: string; updatedAt?: string } {
  const ts = options.timestamps ?? true;
  if (ts === false) return {};
  if (ts === true) return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
  const out: { createdAt?: string; updatedAt?: string } = {};
  if (ts.createdAt !== false) out.createdAt = ts.createdAt ?? 'createdAt';
  if (ts.updatedAt !== false) out.updatedAt = ts.updatedAt ?? 'updatedAt';
  return out;
}

// ── Default operator codes ───────────────────────────────────────────────────

const STATIC_DEFAULT_OPERATORS: Record<string, () => unknown> = {
  $now: () => new Date(),
  $uuid: () => randomUUID(),
  $timestamp: () => Date.now(),
  $shortId: () => randomBytes(12).toString('base64url'),
};

const FIXED_DEFAULT_OPERATORS = new Set(['$now', '$uuid', '$objectId', '$timestamp', '$shortId']);

function isCurrentUserOperator(value: unknown): value is '$currentUser' | `$currentUser.${string}` {
  return (
    typeof value === 'string' && (value === '$currentUser' || value.startsWith('$currentUser.'))
  );
}

export function isDefaultOperator(value: unknown): value is DefaultOperator {
  return (
    (typeof value === 'string' && FIXED_DEFAULT_OPERATORS.has(value)) ||
    isCurrentUserOperator(value)
  );
}

/**
 * Turns a `default` into something evaluated per record: operator codes become
 * generator functions (so each insert — or, for `$currentUser`, each request — gets a
 * fresh value), functions pass through, literals are returned as-is. `objectId` is the
 * engine's id generator (mongoose ObjectId, or a UUID on PostgreSQL).
 */
export function resolveDefault(value: unknown, objectId: () => unknown): unknown {
  if (!isDefaultOperator(value)) return value;
  if (value === '$objectId') return objectId;
  if (value === '$currentUser') return () => getCurrentUser();
  if (isCurrentUserOperator(value)) {
    const key = value.slice('$currentUser.'.length);
    return () => getCurrentUser()?.[key];
  }
  return STATIC_DEFAULT_OPERATORS[value];
}

/** Applies defaults for missing top-level fields and nested object fields (PostgreSQL path). */
export function applyDefaults(
  tree: SchemaTree,
  data: Record<string, unknown>,
  objectId: () => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [key, node] of Object.entries(tree)) {
    if (out[key] === undefined && node.def.default !== undefined) {
      const d = resolveDefault(node.def.default, objectId);
      const value = typeof d === 'function' ? (d as () => unknown)() : structuredClone(d);
      if (value !== undefined) out[key] = value;
    }
    if (node.kind === 'object' && out[key] != null && typeof out[key] === 'object') {
      out[key] = applyDefaults(node.fields, out[key] as Record<string, unknown>, objectId);
    }
    if (node.kind === 'array' && node.item.kind === 'object' && Array.isArray(out[key])) {
      const fields = node.item.fields;
      out[key] = (out[key] as unknown[]).map((v) =>
        v != null && typeof v === 'object'
          ? applyDefaults(fields, v as Record<string, unknown>, objectId)
          : v,
      );
    }
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface FieldIssue {
  path: string;
  message: string;
}

/** Thrown by every model write that fails validation, on either engine. → HTTP 400. */
export class ModelValidationError extends HttpError {
  readonly issues: FieldIssue[];

  constructor(model: string, issues: FieldIssue[]) {
    super(
      400,
      `${model} validation failed: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'ModelValidationError';
    this.issues = issues;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INT4 = 2 ** 31;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;
const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** Digits before / after the point of a decimal string or number. */
function decimalDigits(value: string | number): { int: number; frac: number } {
  const str = typeof value === 'number' ? String(value) : value;
  const [i = '', f = ''] = str.replace(/^[+-]/, '').split('.');
  return { int: i.replace(/^0+/, '').length, frac: f.replace(/0+$/, '').length };
}

function typeError(type: ScalarType, def: AnyFieldDefinition, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= -INT4 && value < INT4
        ? null
        : 'must be a 32-bit integer';
    case 'bigint': {
      const big =
        typeof value === 'bigint'
          ? value
          : typeof value === 'number' && Number.isSafeInteger(value)
            ? BigInt(value)
            : undefined;
      return big !== undefined && big >= INT8_MIN && big <= INT8_MAX
        ? null
        : 'must be a 64-bit integer (bigint)';
    }
    case 'decimal': {
      const ok =
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && DECIMAL_RE.test(value));
      if (!ok) return 'must be a decimal number or numeric string';
      if (def.precision !== undefined) {
        const scale = def.scale ?? 0;
        const { int, frac } = decimalDigits(value as string | number);
        if (frac > scale) return `must have at most ${scale} decimal places`;
        if (int > def.precision - scale)
          return `must have at most ${def.precision - scale} digits before the decimal point`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'date':
      return !Number.isNaN(new Date(value as string | number | Date).getTime())
        ? null
        : 'must be a date';
    case 'objectId':
      return typeof value === 'string' && UUID_RE.test(value) ? null : 'must be a valid id';
    case 'uuid':
      return typeof value === 'string' && UUID_RE.test(value) ? null : 'must be a UUID';
  }
}

type Bound = number | bigint | string | Date;

/** < 0 / 0 / > 0 comparing a (type-checked) value with a min/max bound. */
function compareBound(def: AnyFieldDefinition, value: unknown, bound: Bound): number {
  if (def.type === 'bigint') {
    const a = BigInt(value as bigint | number);
    const b = BigInt(bound instanceof Date ? bound.getTime() : bound);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const num = (v: unknown) =>
    v instanceof Date
      ? v.getTime()
      : def.type === 'date'
        ? new Date(v as string | number).getTime()
        : Number(v);
  return num(value) - num(bound);
}

async function checkRules(
  def: AnyFieldDefinition,
  value: unknown,
  path: string,
  issues: FieldIssue[],
) {
  if (def.enum && !def.enum.includes(value as string | number)) {
    issues.push({ path, message: `must be one of: ${def.enum.join(', ')}` });
  }
  const ordered =
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Date ||
    def.type === 'date' ||
    (def.type === 'decimal' && typeof value === 'string');
  if (ordered) {
    if (def.min !== undefined && compareBound(def, value, def.min) < 0)
      issues.push({ path, message: `must be >= ${String(def.min)}` });
    if (def.max !== undefined && compareBound(def, value, def.max) > 0)
      issues.push({ path, message: `must be <= ${String(def.max)}` });
  }
  if (typeof value === 'string' && def.type !== 'decimal') {
    if (def.minLength !== undefined && value.length < def.minLength)
      issues.push({ path, message: `must be at least ${def.minLength} characters` });
    if (def.maxLength !== undefined && value.length > def.maxLength)
      issues.push({ path, message: `must be at most ${def.maxLength} characters` });
    if (def.match && !def.match.test(value))
      issues.push({ path, message: `must match ${String(def.match)}` });
  }
  if (def.validate) {
    const result = await def.validate(value);
    if (result !== true)
      issues.push({ path, message: typeof result === 'string' ? result : 'is invalid' });
  }
}

async function validateNode(
  node: FieldNode,
  value: unknown,
  path: string,
  issues: FieldIssue[],
  partial: boolean,
) {
  if (value === undefined || value === null) {
    if (node.def.required && !partial) issues.push({ path, message: 'is required' });
    if (node.def.required && partial && value === null)
      issues.push({ path, message: 'is required' });
    return;
  }
  switch (node.kind) {
    case 'scalar': {
      const err = typeError(node.type, node.def, value);
      if (err) {
        issues.push({ path, message: err });
        return;
      }
      await checkRules(node.def, value, path, issues);
      return;
    }
    case 'json':
      await checkRules(node.def, value, path, issues);
      return;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: 'must be an object' });
        return;
      }
      await validateTree(node.fields, value as Record<string, unknown>, issues, false, path);
      await checkRules(node.def, value, path, issues);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        issues.push({ path, message: 'must be an array' });
        return;
      }
      for (let i = 0; i < value.length; i++) {
        await validateNode(
          { ...node.item, def: { ...node.item.def, required: true } } as FieldNode,
          value[i],
          `${path}.${i}`,
          issues,
          false,
        );
      }
      await checkRules(node.def, value, path, issues);
  }
}

/**
 * Validates `data` against the tree. `partial` (updates) only checks fields present in
 * `data`, but still rejects explicitly nulling a required field.
 */
export async function validateTree(
  tree: SchemaTree,
  data: Record<string, unknown>,
  issues: FieldIssue[],
  partial: boolean,
  prefix = '',
): Promise<FieldIssue[]> {
  for (const [key, node] of Object.entries(tree)) {
    if (partial && !(key in data)) continue;
    await validateNode(node, data[key], prefix ? `${prefix}.${key}` : key, issues, partial);
  }
  return issues;
}

/** Fields declared with `ref` (top-level objectId or objectId arrays) → referenced model name. */
export function refFields(tree: SchemaTree): Map<string, { model: string; many: boolean }> {
  const refs = new Map<string, { model: string; many: boolean }>();
  for (const [key, node] of Object.entries(tree)) {
    if (node.kind === 'scalar' && node.type === 'objectId' && node.def.ref) {
      refs.set(key, { model: node.def.ref, many: false });
    } else if (
      node.kind === 'array' &&
      node.item.kind === 'scalar' &&
      node.item.type === 'objectId' &&
      node.def.ref
    ) {
      refs.set(key, { model: node.def.ref, many: true });
    }
  }
  return refs;
}

export function sequenceFields(name: string, tree: SchemaTree): { path: string; key: string }[] {
  const out: { path: string; key: string }[] = [];
  for (const [path, node] of Object.entries(tree)) {
    if (node.def.sequence) {
      out.push({
        path,
        key: typeof node.def.sequence === 'string' ? node.def.sequence : `${name}.${path}`,
      });
    }
  }
  return out;
}

/** The schema node a dotted path points at (`meta.counts.views`, `items.0.sku`), if any. */
export function nodeAt(tree: SchemaTree, path: string[]): FieldNode | undefined {
  let node: FieldNode | undefined = tree[path[0]!];
  for (const part of path.slice(1)) {
    if (!node) return undefined;
    if (node.kind === 'object') node = node.fields[part];
    else if (node.kind === 'array' && /^\d+$/.test(part)) node = node.item;
    else if (node.kind === 'json')
      return node; // untyped JSON: anything goes below here
    else return undefined;
  }
  return node;
}

/** Validates one value written to a dotted path (partial-update rules). */
export async function validateAtPath(
  tree: SchemaTree,
  dotted: string,
  value: unknown,
  issues: FieldIssue[],
): Promise<void> {
  const node = nodeAt(tree, dotted.split('.'));
  if (!node) {
    issues.push({ path: dotted, message: 'unknown field' });
    return;
  }
  await validateNode(node, value, dotted, issues, true);
}
