// `efc db pull` on PostgreSQL: reads the current schema's tables, columns, keys, indexes,
// enums and checks and describes them as `defineTable` models (with back-relations).
// A schema EFC created pulls back to models that sync finds nothing to change in.
import type { Pool } from 'pg';
import { lcFirst, camel, pascal, plural, singular, type ModelSource } from './codegen.js';
import { snakeCase, tableNameFor } from './pg-table.js';

interface Column {
  table: string;
  name: string;
  num: number;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: string;
  enumLabels: string[] | null;
}
interface Index {
  table: string;
  name: string;
  unique: boolean;
  primary: boolean;
  def: string;
}
interface ForeignKey {
  table: string;
  name: string;
  columns: string[];
  target: string;
  targetColumns: string[];
  action: string;
}
interface Check {
  table: string;
  name: string;
  def: string;
}

/** Tables EFC and task backends keep for themselves. */
const INTERNAL = new Set(['efc_migrations', 'efc_counters']);

const quoteIdents = (s: string) => s.replace(/"/g, '');

/** Literal values in a CHECK (... IN (...)) / = ANY (ARRAY[...]) definition. */
function checkValues(def: string, numeric: boolean): (string | number)[] {
  if (numeric) return [...def.matchAll(/\(?(-?\d+(?:\.\d+)?)\)?::/g)].map((m) => Number(m[1]));
  return [...def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

function scalarType(type: string): { def: Record<string, unknown>; note?: string } {
  let m: RegExpExecArray | null;
  if (type === 'text') return { def: { type: 'string' } };
  if ((m = /^character varying(?:\((\d+)\))?$/.exec(type)))
    return { def: m[1] ? { type: 'string', maxLength: Number(m[1]) } : { type: 'string' } };
  if (/^character(\(\d+\))?$/.test(type)) return { def: { type: 'string' } };
  if (type === 'double precision' || type === 'real') return { def: { type: 'number' } };
  if (type === 'integer' || type === 'smallint') return { def: { type: 'integer' } };
  if (type === 'bigint') return { def: { type: 'bigint' } };
  if ((m = /^numeric(?:\((\d+),(\d+)\))?$/.exec(type)))
    return {
      def: m[1]
        ? { type: 'decimal', precision: Number(m[1]), scale: Number(m[2]) }
        : { type: 'decimal' },
    };
  if (type === 'boolean') return { def: { type: 'boolean' } };
  if (/^timestamp/.test(type) || type === 'date') return { def: { type: 'date' } };
  if (type === 'uuid') return { def: { type: 'uuid' } };
  if (type === 'jsonb' || type === 'json') return { def: { type: 'json' } };
  return { def: { type: 'json' }, note: `${type} has no EFC type — mapped to json` };
}

export async function pullPostgres(
  pool: Pool,
): Promise<{ models: ModelSource[]; skipped: string[] }> {
  const q = async <R>(sql: string) => (await pool.query(sql)).rows as R[];
  const tables = (
    await q<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') ORDER BY 1`,
    )
  )
    .map((r) => r.name)
    .filter((t) => !INTERNAL.has(t));
  const columns = await q<Column>(
    `SELECT c.relname AS table, a.attname AS name, a.attnum AS num,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
            pg_get_expr(d.adbin, d.adrelid) AS default, a.attidentity AS identity,
            CASE WHEN t.typtype = 'e' THEN (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
              FROM pg_enum e WHERE e.enumtypid = t.oid) END AS "enumLabels"
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`,
  );
  const indexes = await q<Index>(
    `SELECT t.relname AS table, i.relname AS name, x.indisunique AS unique, x.indisprimary AS primary,
            pg_get_indexdef(x.indexrelid) AS def
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = current_schema() ORDER BY 1, 2`,
  );
  const fks = await q<ForeignKey>(
    `SELECT c.relname AS table, con.conname AS name, ft.relname AS target, con.confdeltype AS action,
            ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
            ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS "targetColumns"
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class ft ON ft.oid = con.confrelid WHERE n.nspname = current_schema() AND con.contype = 'f' ORDER BY 1, 2`,
  );
  const checks = await q<Check>(
    `SELECT c.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND con.contype = 'c' ORDER BY 1, 2`,
  );

  const colsOf = (t: string) => columns.filter((c) => c.table === t);
  const fksOf = (t: string) => fks.filter((f) => f.table === t);

  // Join tables EFC made for many-to-many refs: (owner_id, ref_id, position).
  const joinTables = new Map<string, { owner: string; target: string; column: string }>();
  for (const t of tables) {
    const names = colsOf(t)
      .map((c) => c.name)
      .sort()
      .join(',');
    if (names !== 'owner_id,position,ref_id') continue;
    const owner = fksOf(t).find((f) => f.columns[0] === 'owner_id')?.target;
    const target = fksOf(t).find((f) => f.columns[0] === 'ref_id')?.target;
    if (owner && target && t.startsWith(`${owner}_`))
      joinTables.set(t, { owner, target, column: t.slice(owner.length + 1) });
  }

  // Which tables become models: a single-column primary key named id.
  const models = new Map<string, { table: string; name: string; idKind: string }>();
  const skipped: string[] = [];
  for (const t of tables) {
    if (joinTables.has(t)) continue;
    const pk = indexes.find((i) => i.table === t && i.primary);
    const id = colsOf(t).find((c) => c.name === 'id');
    if (!pk || !id || !/\("?id"?\)$/.test(pk.def)) {
      skipped.push(t);
      continue;
    }
    const idKind =
      id.type === 'uuid'
        ? 'uuid'
        : id.type === 'bigint'
          ? 'bigserial'
          : id.type === 'integer'
            ? 'serial'
            : '';
    if (!idKind) {
      skipped.push(t);
      continue;
    }
    models.set(t, { table: t, name: pascal(singular(t)), idKind });
  }
  const modelName = (t: string) => models.get(t)?.name;

  const out: ModelSource[] = [];
  const relations = new Map<string, Record<string, unknown>>();
  const relationNames = new Map<string, Set<string>>();

  for (const { table, name, idKind } of models.values()) {
    const cols = colsOf(table);
    const notes: string[] = [];
    // snake_case naming when every underscored column is the snake_case of a field name.
    const underscored = cols.filter((c) => c.name.includes('_'));
    const snake =
      underscored.length > 0 && underscored.every((c) => snakeCase(camel(c.name)) === c.name);
    const fieldOf = (column: string) => (snake ? camel(column) : column);
    const options: Record<string, unknown> = {};
    if (snake) options['naming'] = 'snake_case';
    if (idKind !== 'uuid') options['id'] = idKind;
    const defaultTable = tableNameFor(snake ? snakeCase(name) : name);
    if (defaultTable !== table) options['collection'] = table;

    // Timestamps: EFC's createdAt/updatedAt columns (timestamptz).
    const tsColumn = (f: string) => cols.find((c) => c.name === (snake ? snakeCase(f) : f));
    const isTs = (c?: Column) => c?.type === 'timestamp with time zone';
    const hasCreated = isTs(tsColumn('createdAt'));
    const hasUpdated = isTs(tsColumn('updatedAt'));
    if (!hasCreated && !hasUpdated) options['timestamps'] = false;
    else if (!hasCreated) options['timestamps'] = { createdAt: false };
    else if (!hasUpdated) options['timestamps'] = { updatedAt: false };
    const tsColumns = new Set(
      [hasCreated && tsColumn('createdAt')!.name, hasUpdated && tsColumn('updatedAt')!.name].filter(
        Boolean,
      ) as string[],
    );

    const tableIndexes = indexes.filter((i) => i.table === table && !i.primary);
    const tableFks = fksOf(table);
    const tableChecks = checks.filter((c) => c.table === table);
    const fields: [string, Record<string, unknown>][] = [];
    const usedIndexes = new Set<string>();
    const usedChecks = new Set<string>();

    const taken = new Set(cols.map((c) => fieldOf(c.name)));
    for (const col of cols) {
      if (col.name === 'id' || tsColumns.has(col.name)) continue;
      let field = fieldOf(col.name);
      // authorId / author_id holding a foreign key → the relation's name, author.
      const fkCol = tableFks.some((f) => f.columns.length === 1 && f.columns[0] === col.name);
      const stem = /^(.+?)(?:Id|_id)$/.exec(col.name)?.[1];
      if (fkCol && stem && !taken.has(camel(stem))) {
        taken.add(camel(stem));
        field = camel(stem);
      }
      let def: Record<string, unknown>;
      if (col.enumLabels) {
        def = { type: 'string', enum: col.enumLabels, nativeEnum: true };
      } else if (col.type.endsWith('[]')) {
        const item = scalarType(col.type.slice(0, -2));
        def = { type: 'array', of: item.def['type'] };
        if (item.note) notes.push(`${field}: ${item.note}`);
      } else {
        const s = scalarType(col.type);
        def = { ...s.def };
        if (s.note) notes.push(`${field}: ${s.note}`);
      }
      if (col.notNull) def['required'] = true;
      if (col.default) {
        const d = col.default;
        const seq = /^nextval\('(?:"?[^.']*"?\.)?"?(efc_seq_[^"']+)"?'::regclass\)$/.exec(d);
        if (seq) {
          const own = `efc_seq_${`${name}.${field}`.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()}`;
          def['sequence'] = seq[1] === own ? true : seq[1]!.slice('efc_seq_'.length);
          def['type'] = 'number';
        } else if (/^(now\(\)|CURRENT_TIMESTAMP)/i.test(d)) def['default'] = '$now';
        else if (/^gen_random_uuid\(\)$/.test(d)) def['default'] = '$uuid';
        else if (/^(true|false)$/.test(d)) def['default'] = d === 'true';
        else if (/^\(?-?\d+(\.\d+)?\)?(::[a-z ]+)?$/.test(d))
          def['default'] = Number(d.replace(/[()]|::.*$/g, ''));
        else if (/^'((?:[^']|'')*)'(::.*)?$/.test(d))
          def['default'] = /^'((?:[^']|'')*)'/.exec(d)![1]!.replace(/''/g, "'");
        else notes.push(`${field}: database default ${d} not carried over`);
      }
      if ((snake ? snakeCase(field) : field) !== col.name) def['column'] = col.name;

      // A foreign key on this one column.
      const fk = tableFks.find((f) => f.columns.length === 1 && f.columns[0] === col.name);
      if (fk) {
        const target = modelName(fk.target);
        if (target && fk.targetColumns[0] === 'id') {
          def['ref'] = target;
          if (fk.action === 'c') def['onDelete'] = 'cascade';
          else if (fk.action === 'n') def['onDelete'] = 'setNull';
          if (fk.name !== `${table}_${col.name}_fkey`)
            notes.push(
              `${field}: foreign key "${fk.name}" will be recreated as "${table}_${col.name}_fkey"`,
            );
        } else notes.push(`${field}: foreign key "${fk.name}" to ${fk.target} not carried over`);
      }

      // Single-column indexes EFC names <table>_<column>_key / _idx.
      const cols1 = (i: Index) =>
        /\(([^()]*)\)$/
          .exec(i.def)?.[1]
          ?.split(',')
          .map((s) => quoteIdents(s.trim()));
      const own = tableIndexes.filter((i) => {
        const c = cols1(i);
        return c?.length === 1 && c[0] === col.name;
      });
      const unique = own.find((i) => i.unique && i.name === `${table}_${col.name}_key`);
      const plain = own.find((i) => !i.unique && i.name === `${table}_${col.name}_idx`);
      if (unique) {
        def['unique'] = true;
        usedIndexes.add(unique.name);
      }
      if (plain) {
        if (!def['ref']) def['index'] = true;
        usedIndexes.add(plain.name);
      } else if (def['ref'] && !unique) def['index'] = false;

      // Enum CHECKs EFC names <table>_<column>_enum.
      const check = tableChecks.find((c) => c.name === `${table}_${col.name}_enum`);
      if (check && !col.enumLabels) {
        def['enum'] = checkValues(check.def, def['type'] === 'number' || def['type'] === 'integer');
        usedChecks.add(check.name);
      }
      fields.push([field, def]);
    }

    // Many-to-many arrays: this table's join tables.
    for (const j of joinTables.values()) {
      if (j.owner !== table) continue;
      const target = models.get(j.target);
      if (!target) continue;
      const of =
        target.idKind === 'uuid' ? 'uuid' : target.idKind === 'bigserial' ? 'bigint' : 'integer';
      fields.push([fieldOf(j.column), { type: 'array', of, ref: target.name }]);
    }

    // Other indexes: compound, differently named, text.
    const fieldOfColumn = (c: string) =>
      fields.find(([f, d]) => (d['column'] ?? (snake ? snakeCase(f) : f)) === c)?.[0] ?? fieldOf(c);
    const indexDefs: Record<string, unknown>[] = [];
    for (const idx of tableIndexes) {
      if (usedIndexes.has(idx.name)) continue;
      const text = [...idx.def.matchAll(/coalesce\(\("?([^"()]+)"?\)::text/g)].map((m) => m[1]!);
      if (/to_tsvector/.test(idx.def) && text.length) {
        indexDefs.push({
          fields: Object.fromEntries(text.map((c) => [fieldOfColumn(c), 'text'])),
          ...(idx.name !== `${table}_${text.join('_')}_idx` && { name: idx.name }),
        });
        continue;
      }
      const body = /USING \w+ \((.*)\)$/.exec(idx.def)?.[1];
      if (!body || /\(/.test(body) || / WHERE /.test(idx.def)) {
        notes.push(`index "${idx.name}" (an expression or partial index) not carried over`);
        continue;
      }
      const parts = body.split(',').map((p) => p.trim());
      const fieldsSpec = Object.fromEntries(
        parts.map((p) => {
          const desc = / DESC$/.test(p);
          return [fieldOfColumn(quoteIdents(p.replace(/ (ASC|DESC)$/, ''))), desc ? -1 : 1];
        }),
      );
      const efcName = `${table}_${parts.map((p) => quoteIdents(p.replace(/ (ASC|DESC)$/, ''))).join('_')}_${idx.unique ? 'key' : 'idx'}`;
      indexDefs.push({
        fields: fieldsSpec,
        ...(idx.unique && { unique: true }),
        ...(idx.name !== efcName && { name: idx.name }),
      });
    }
    if (indexDefs.length) options['indexes'] = indexDefs;
    for (const c of tableChecks)
      if (!usedChecks.has(c.name)) notes.push(`check "${c.name}" not carried over: ${c.def}`);
    for (const f of tableFks)
      if (f.columns.length > 1) notes.push(`foreign key "${f.name}" (composite) not carried over`);

    // Back-relations on the targets of this model's refs.
    const byTarget = new Map<string, string[]>();
    for (const [field, def] of fields) {
      const ref = def['ref'] as string | undefined;
      if (ref) byTarget.set(ref, [...(byTarget.get(ref) ?? []), field]);
    }
    for (const [target, refFields] of byTarget) {
      for (const field of refFields) {
        const def = fields.find(([f]) => f === field)![1];
        const many = def['type'] === 'array' || !def['unique'];
        let rel = many ? plural(lcFirst(name)) : lcFirst(name);
        if (refFields.length > 1) rel = `${rel}By${pascal(field)}`;
        const taken = relationNames.get(target) ?? new Set<string>();
        while (taken.has(rel)) rel = `${rel}_`;
        taken.add(rel);
        relationNames.set(target, taken);
        const rels = relations.get(target) ?? {};
        rels[rel] = many
          ? { hasMany: name, foreignKey: field }
          : { hasOne: name, foreignKey: field };
        relations.set(target, rels);
      }
    }

    out.push({ name, fields, options, notes });
  }

  for (const model of out) {
    const rels = relations.get(model.name);
    if (!rels) continue;
    // A relation can't share a name with a field.
    const fieldNames = new Set(model.fields.map(([f]) => f));
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rels)) safe[fieldNames.has(k) ? `${k}List` : k] = v;
    model.options['relations'] = safe;
  }
  return { models: out, skipped };
}
