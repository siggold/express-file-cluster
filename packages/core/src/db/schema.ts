import { randomBytes, randomUUID } from 'node:crypto';
import type {
  DefaultOperator,
  FieldDefinition,
  ModelSchema,
  ModelOptions,
  PrimitiveFieldType,
  SchemaField,
} from '../types.js';
import { getCurrentUser } from '../context.js';
import { HttpError } from '../errors.js';

// ── Normalised schema tree ───────────────────────────────────────────────────
// The three accepted field syntaxes (FieldDefinition, nested-schema shorthand,
// [schema] tuple) collapse into one tree that both engine adapters walk.

export type ScalarType = Exclude<PrimitiveFieldType, 'object'>;

export type FieldNode =
  | { kind: 'scalar'; type: ScalarType; def: FieldDefinition }
  | { kind: 'json'; def: FieldDefinition } // untyped object / untyped array
  | { kind: 'object'; fields: SchemaTree; def: FieldDefinition }
  | { kind: 'array'; item: FieldNode; def: FieldDefinition };

export type SchemaTree = Record<string, FieldNode>;

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date', 'object', 'objectId', 'array']);

export function isFieldDefinition(value: unknown): value is FieldDefinition {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string' &&
    FIELD_TYPES.has((value as { type: string }).type)
  );
}

function itemNode(of: FieldDefinition['of'], parent: FieldDefinition): FieldNode {
  if (of === undefined) return { kind: 'json', def: {} as FieldDefinition };
  if (typeof of === 'string') {
    if (of === 'object') return { kind: 'json', def: {} as FieldDefinition };
    const def: FieldDefinition = { type: of, ...(parent.ref !== undefined && { ref: parent.ref }) };
    return { kind: 'scalar', type: of, def };
  }
  return { kind: 'object', fields: normalizeSchema(of), def: { type: 'object' } };
}

function normalizeField(field: SchemaField): FieldNode {
  if (Array.isArray(field)) {
    const inner = field[0];
    return {
      kind: 'array',
      item: inner
        ? { kind: 'object', fields: normalizeSchema(inner), def: { type: 'object' } }
        : { kind: 'json', def: {} as FieldDefinition },
      def: { type: 'array' },
    };
  }
  if (!isFieldDefinition(field)) {
    return { kind: 'object', fields: normalizeSchema(field), def: { type: 'object' } };
  }
  const def = field;
  if (def.type === 'array') return { kind: 'array', item: itemNode(def.of, def), def };
  if (def.type === 'object') {
    return def.fields
      ? { kind: 'object', fields: normalizeSchema(def.fields), def }
      : { kind: 'json', def };
  }
  return { kind: 'scalar', type: def.type, def };
}

export function normalizeSchema(schema: ModelSchema): SchemaTree {
  const out: SchemaTree = {};
  for (const [key, field] of Object.entries(schema)) out[key] = normalizeField(field);
  return out;
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

function typeError(type: ScalarType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'date':
      return !Number.isNaN(new Date(value as string | number | Date).getTime())
        ? null
        : 'must be a date';
    case 'objectId':
      return typeof value === 'string' && UUID_RE.test(value) ? null : 'must be a valid id';
  }
}

async function checkRules(
  def: FieldDefinition,
  value: unknown,
  path: string,
  issues: FieldIssue[],
) {
  if (def.enum && !def.enum.includes(value as string | number)) {
    issues.push({ path, message: `must be one of: ${def.enum.join(', ')}` });
  }
  if (typeof value === 'number' || value instanceof Date || def.type === 'date') {
    const n =
      value instanceof Date
        ? value.getTime()
        : def.type === 'date'
          ? new Date(value as string).getTime()
          : (value as number);
    const bound = (b: number | Date) => (b instanceof Date ? b.getTime() : b);
    if (def.min !== undefined && n < bound(def.min))
      issues.push({ path, message: `must be >= ${String(def.min)}` });
    if (def.max !== undefined && n > bound(def.max))
      issues.push({ path, message: `must be <= ${String(def.max)}` });
  }
  if (typeof value === 'string') {
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
      const err = typeError(node.type, value);
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
