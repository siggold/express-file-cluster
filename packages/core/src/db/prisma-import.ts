// `efc import-prisma schema.prisma`: Prisma models → `defineTable` models over the same
// tables. Tables and columns keep Prisma's names (`collection` / `column`), relations
// become refs (a relation's foreign-key scalar is folded into it) and back-relations.
import type { ModelSource } from './codegen.js';
import { tableNameFor } from './pg-table.js';

interface Attr {
  name: string;
  /** Raw argument text inside the parentheses (absent when the attribute has none). */
  args?: string;
}
interface PField {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  attrs: Attr[];
}
interface PModel {
  name: string;
  fields: PField[];
  blockAttrs: Attr[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Splits on `sep` at depth 0 (outside (), [], {} and strings). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let str: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (str) {
      cur += ch;
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'") str = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `@id @default(uuid()) @map("x")` → attributes, balancing parentheses. */
function parseAttrs(s: string): Attr[] {
  const out: Attr[] = [];
  let i = 0;
  while (i < s.length) {
    const m = /^@@?[\w.]+/.exec(s.slice(i));
    if (!m) {
      i++;
      continue;
    }
    i += m[0].length;
    const attr: Attr = { name: m[0] };
    if (s[i] === '(') {
      let depth = 0;
      let j = i;
      let str: string | null = null;
      for (; j < s.length; j++) {
        const ch = s[j]!;
        if (str) {
          if (ch === str) str = null;
          continue;
        }
        if (ch === '"') str = ch;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
      }
      attr.args = s.slice(i + 1, j);
      i = j + 1;
    }
    out.push(attr);
  }
  return out;
}

/** Named argument (`fields: [a]`) or the first positional one. */
function arg(a: Attr | undefined, name?: string): string | undefined {
  if (!a?.args) return undefined;
  const parts = splitTop(a.args, ',');
  if (name) {
    const p = parts.find((x) => x.startsWith(`${name}:`));
    return p?.slice(name.length + 1).trim();
  }
  return parts.find((x) => !/^\w+\s*:/.test(x));
}
const unquote = (s?: string) => s?.replace(/^"(.*)"$/, '$1');
const list = (s?: string) =>
  s
    ? splitTop(s.replace(/^\[|\]$/g, ''), ',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

export function parsePrisma(source: string): {
  models: PModel[];
  enums: Map<string, { values: string[]; names: string[]; map?: string }>;
  provider?: string;
} {
  const text = source.replace(/\/\/.*$/gm, '');
  const models: PModel[] = [];
  const enums = new Map<string, { values: string[]; names: string[]; map?: string }>();
  let provider: string | undefined;
  for (const block of text.matchAll(
    /(model|enum|datasource|generator|type|view)\s+(\w+)\s*\{([^}]*)\}/g,
  )) {
    const [, kind, name, body] = block;
    const lines = body!
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (kind === 'datasource') {
      provider = unquote(/provider\s*=\s*("[^"]*")/.exec(body!)?.[1]);
    } else if (kind === 'enum') {
      const values: string[] = [];
      const names: string[] = [];
      let map: string | undefined;
      for (const l of lines) {
        if (l.startsWith('@@map')) map = unquote(arg(parseAttrs(l)[0]));
        else {
          const [value, ...rest] = l.split(/\s+/);
          const mapped = unquote(arg(parseAttrs(rest.join(' ')).find((a) => a.name === '@map')));
          names.push(value!);
          values.push(mapped ?? value!);
        }
      }
      enums.set(name!, { values, names, ...(map && { map }) });
    } else if (kind === 'model') {
      const fields: PField[] = [];
      const blockAttrs: Attr[] = [];
      for (const l of lines) {
        if (l.startsWith('@@')) {
          blockAttrs.push(...parseAttrs(l));
          continue;
        }
        const m = /^(\w+)\s+([\w.]+(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/.exec(l);
        if (!m) continue;
        fields.push({
          name: m[1]!,
          type: m[2]!,
          list: Boolean(m[3]),
          optional: Boolean(m[4]),
          attrs: parseAttrs(m[5]!),
        });
      }
      models.push({ name: name!, fields, blockAttrs });
    }
  }
  return { models, enums, ...(provider && { provider }) };
}

// ── Mapping ──────────────────────────────────────────────────────────────────

type IdKind = 'uuid' | 'serial' | 'bigserial';
const ID_FIELD_TYPE: Record<IdKind, string> = {
  uuid: 'uuid',
  serial: 'integer',
  bigserial: 'bigint',
};
const ACTIONS: Record<string, string> = { Cascade: 'cascade', SetNull: 'setNull' };

export function importPrisma(source: string): { models: ModelSource[]; warnings: string[] } {
  const { models, enums, provider } = parsePrisma(source);
  const warnings: string[] = [];
  if (provider && provider !== 'postgresql' && provider !== 'postgres') {
    throw new Error(
      `[EFC] import-prisma maps PostgreSQL schemas to defineTable — this one's provider is "${provider}"`,
    );
  }
  const byName = new Map(models.map((m) => [m.name, m]));
  const attr = (f: PField, n: string) => f.attrs.find((a) => a.name === n);
  const blocks = (m: PModel, n: string) => m.blockAttrs.filter((a) => a.name === n);
  const dbName = (f: PField) => unquote(arg(attr(f, '@map'))) ?? f.name;

  const idKind = new Map<string, IdKind>();
  for (const m of models) {
    const id = m.fields.find((f) => attr(f, '@id'));
    const def = arg(attr(id ?? ({ attrs: [] } as unknown as PField), '@default')) ?? '';
    idKind.set(
      m.name,
      id?.type === 'Int' && /autoincrement/.test(def)
        ? 'serial'
        : id?.type === 'BigInt' && /autoincrement/.test(def)
          ? 'bigserial'
          : 'uuid',
    );
  }

  // Relations: which side holds the foreign key, and what each list/back field points at.
  interface Rel {
    model: string;
    field: string;
    target: string;
    name?: string;
    fkScalars: string[];
    list: boolean;
    optional: boolean;
    onDelete?: string;
  }
  const rels: Rel[] = [];
  for (const m of models) {
    for (const f of m.fields) {
      if (!byName.has(f.type)) continue;
      const r = attr(f, '@relation');
      const relName = unquote(arg(r)) ?? unquote(arg(r, 'name'));
      rels.push({
        model: m.name,
        field: f.name,
        target: f.type,
        ...(relName && { name: relName }),
        fkScalars: list(arg(r, 'fields')),
        list: f.list,
        optional: f.optional,
        ...(arg(r, 'onDelete') && { onDelete: arg(r, 'onDelete')! }),
      });
    }
  }
  const sameRelation = (a: Rel, b: Rel) =>
    a !== b && a.target === b.model && b.target === a.model && (a.name ?? '') === (b.name ?? '');
  const partner = (r: Rel) =>
    rels.find((o) => sameRelation(r, o) && (r.model !== r.target || o.field !== r.field));

  const out: ModelSource[] = [];
  for (const m of models) {
    const notes: string[] = [];
    const options: Record<string, unknown> = {};
    const fields: [string, Record<string, unknown>][] = [];
    const relations: Record<string, unknown> = {};
    const table = unquote(arg(blocks(m, '@@map')[0])) ?? m.name;
    if (table !== tableNameFor(m.name)) options['collection'] = table;
    const kind = idKind.get(m.name)!;
    if (kind !== 'uuid') options['id'] = kind;
    if (blocks(m, '@@id').length) {
      warnings.push(`${m.name}: composite @@id isn't supported — skipped`);
      continue;
    }

    // Foreign-key scalars are folded into their relation field.
    const fkScalar = new Map<string, Rel>();
    for (const r of rels.filter((x) => x.model === m.name && x.fkScalars.length)) {
      if (r.fkScalars.length > 1) {
        notes.push(`${r.field}: composite foreign keys aren't supported — kept as plain columns`);
        continue;
      }
      fkScalar.set(r.fkScalars[0]!, r);
    }
    const renamed = new Map<string, string>(); // Prisma field → EFC field (for @@index)

    // Timestamps: createdAt (@default(now())) and updatedAt (@updatedAt), unmapped.
    const created = m.fields.find(
      (f) => f.name === 'createdAt' && f.type === 'DateTime' && !attr(f, '@map'),
    );
    const updated = m.fields.find(
      (f) => f.name === 'updatedAt' && f.type === 'DateTime' && !attr(f, '@map'),
    );
    if (!created && !updated) options['timestamps'] = false;
    else if (!created) options['timestamps'] = { createdAt: false };
    else if (!updated) options['timestamps'] = { updatedAt: false };

    for (const f of m.fields) {
      if (f === created || f === updated) continue;
      if (attr(f, '@id')) {
        if (f.name !== 'id') notes.push(`${f.name}: EFC's primary key is always "id"`);
        const def = arg(attr(f, '@default')) ?? '';
        if (f.type === 'String' && !/uuid/.test(def))
          notes.push(
            `id: ${def || 'String'} ids become uuid — existing non-UUID ids won't convert`,
          );
        continue;
      }
      if (byName.has(f.type)) {
        const r = rels.find((x) => x.model === m.name && x.field === f.name)!;
        if (r.fkScalars.length === 1) {
          const scalar = m.fields.find((x) => x.name === r.fkScalars[0]);
          const def: Record<string, unknown> = {
            type: ID_FIELD_TYPE[idKind.get(r.target)!],
            ref: r.target,
          };
          if (!f.optional) def['required'] = true;
          if (scalar && attr(scalar, '@unique')) def['unique'] = true;
          if (r.onDelete && ACTIONS[r.onDelete]) def['onDelete'] = ACTIONS[r.onDelete];
          else if (r.onDelete && r.onDelete !== 'Restrict' && r.onDelete !== 'NoAction')
            notes.push(`${f.name}: onDelete ${r.onDelete} isn't supported — restrict`);
          if (def['onDelete'] === 'setNull') delete def['required'];
          def['column'] = scalar ? dbName(scalar) : `${f.name}Id`;
          if (scalar) renamed.set(scalar.name, f.name);
          fields.push([f.name, def]);
          continue;
        }
        const other = partner(r);
        if (r.list && other?.list) {
          // Implicit many-to-many: the alphabetically first model holds the array.
          if (m.name < r.target || (m.name === r.target && f.name < other.field)) {
            fields.push([
              f.name,
              { type: 'array', of: ID_FIELD_TYPE[idKind.get(r.target)!], ref: r.target },
            ]);
            notes.push(
              `${f.name}: links move to the join table "${table}_${f.name}" — copy them from Prisma's "_${[m.name, r.target].sort().join('To')}" table`,
            );
          } else {
            relations[f.name] = { hasMany: r.target, foreignKey: other.field };
          }
          continue;
        }
        if (other && other.fkScalars.length === 1) {
          const otherScalar = byName
            .get(other.model)!
            .fields.find((x) => x.name === other.fkScalars[0]);
          const unique = otherScalar && attr(otherScalar, '@unique');
          relations[f.name] =
            r.list || !unique
              ? { hasMany: r.target, foreignKey: other.field }
              : { hasOne: r.target, foreignKey: other.field };
        } else {
          notes.push(`${f.name}: relation to ${r.target} not carried over`);
        }
        continue;
      }
      if (fkScalar.has(f.name)) continue;

      const def = scalarDef(f, enums, notes);
      if (!def) continue;
      if (!f.optional && !f.list) def['required'] = true;
      if (attr(f, '@unique')) def['unique'] = true;
      const d = arg(attr(f, '@default'));
      if (d !== undefined) {
        if (d === 'now()') def['default'] = '$now';
        else if (/^(uuid|cuid|nanoid)\(/.test(d)) def['default'] = '$uuid';
        else if (d === 'autoincrement()') {
          def['sequence'] = true;
          def['type'] = 'number';
        } else if (d === 'true' || d === 'false') def['default'] = d === 'true';
        else if (/^-?\d+(\.\d+)?$/.test(d)) def['default'] = Number(d);
        else if (/^".*"$/.test(d)) def['default'] = unquote(d);
        else if (enums.has(f.type)) {
          const e = enums.get(f.type)!;
          def['default'] = e.values[e.names.indexOf(d)] ?? d;
        } else notes.push(`${f.name}: @default(${d}) not carried over`);
      }
      if (attr(f, '@updatedAt')) notes.push(`${f.name}: @updatedAt — use the updatedAt timestamp`);
      if (dbName(f) !== f.name) def['column'] = dbName(f);
      fields.push([f.name, def]);
    }

    const indexes: Record<string, unknown>[] = [];
    for (const a of [...blocks(m, '@@index'), ...blocks(m, '@@unique')]) {
      const spec = Object.fromEntries(
        list(arg(a, 'fields') ?? arg(a)).map((x) => {
          const n = /^(\w+)/.exec(x)![1]!;
          return [renamed.get(n) ?? n, /sort:\s*Desc/.test(x) ? -1 : 1];
        }),
      );
      const name = unquote(arg(a, 'map')) ?? unquote(arg(a, 'name'));
      indexes.push({
        fields: spec,
        ...(a.name === '@@unique' && { unique: true }),
        ...(name && { name }),
      });
    }
    if (indexes.length) options['indexes'] = indexes;
    if (Object.keys(relations).length) options['relations'] = relations;
    out.push({ name: m.name, fields, options, notes });
  }
  return { models: out, warnings };
}

function scalarDef(
  f: PField,
  enums: Map<string, { values: string[] }>,
  notes: string[],
): Record<string, unknown> | undefined {
  const db = f.attrs.find((a) => a.name.startsWith('@db.'));
  const dbType = db?.name.slice(4);
  let def: Record<string, unknown>;
  const e = enums.get(f.type);
  if (e) def = { type: 'string', enum: e.values, nativeEnum: true };
  else {
    switch (f.type) {
      case 'String':
        if (dbType === 'Uuid') def = { type: 'uuid' };
        else if (dbType === 'VarChar' && db?.args)
          def = { type: 'string', maxLength: Number(db.args) };
        else def = { type: 'string' };
        break;
      case 'Int':
        def = { type: 'integer' };
        break;
      case 'BigInt':
        def = { type: 'bigint' };
        break;
      case 'Float':
        def = { type: 'number' };
        break;
      case 'Decimal': {
        const [p, s] = (db?.args ?? '').split(',').map((x) => Number(x.trim()));
        def = p ? { type: 'decimal', precision: p, scale: s ?? 0 } : { type: 'decimal' };
        break;
      }
      case 'Boolean':
        def = { type: 'boolean' };
        break;
      case 'DateTime':
        def = { type: 'date' };
        break;
      case 'Json':
        def = { type: 'json' };
        break;
      default:
        notes.push(`${f.name}: ${f.type} has no EFC type — skipped`);
        return undefined;
    }
  }
  if (f.list) {
    if (def['type'] === 'json' || e) {
      notes.push(`${f.name}: lists of ${f.type} are stored as json`);
      return { type: 'json' };
    }
    return { type: 'array', of: def['type'] };
  }
  return def;
}
