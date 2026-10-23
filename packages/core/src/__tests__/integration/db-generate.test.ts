import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

// `efc db generate | pull | sync --exit-code | migrate --baseline` and `efc import-prisma`
// through the real CLI binary, in throwaway projects. PostgreSQL runs in its own schema
// (search_path in the URL), MongoDB in its own database. Needs the built dist/.
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(CORE, 'dist', 'cli', 'index.js');
const PG = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test';
const MONGO = process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_db_generate_test';

const { default: pg } = await import('pg');
async function pgReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: PG, connectionTimeoutMillis: 1500 });
  return client.connect().then(
    () => client.end().then(() => true),
    () => false,
  );
}
async function mongoReachable(): Promise<boolean> {
  const conn = mongoose.createConnection(MONGO, { serverSelectionTimeoutMS: 1500 });
  return conn.asPromise().then(
    () => conn.close().then(() => true),
    () => false,
  );
}
const built = fs.existsSync(CLI);
const pgUp = built && (await pgReachable());
const mongoUp = built && (await mongoReachable());

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-db-generate-'));
  fs.mkdirSync(path.join(root, 'src', 'model'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(CORE, path.join(root, 'node_modules', 'express-file-cluster'), 'dir');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'gen-app', type: 'module' }),
  );
  return root;
}

/** Runs `efc ...`; returns stdout and the exit code instead of throwing. */
function cli(root: string, url: string, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: url, NO_COLOR: '1' },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

const migrationFiles = (root: string) =>
  fs.existsSync(path.join(root, 'src', 'migrations'))
    ? fs.readdirSync(path.join(root, 'src', 'migrations')).sort()
    : [];
const readMigration = (root: string, suffix: string) =>
  fs.readFileSync(
    path.join(root, 'src', 'migrations', migrationFiles(root).find((f) => f.includes(suffix))!),
    'utf8',
  );

describe.skipIf(!pgUp)('efc db generate / pull — postgresql', { timeout: 120_000 }, () => {
  let root: string;
  let schema: string;
  let url: string;
  const sql = async (text: string) => {
    const client = new pg.Client(PG);
    await client.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  };
  const efc = (...args: string[]) => cli(root, url, ...args);
  const model = (file: string, src: string) =>
    fs.writeFileSync(path.join(root, 'src', 'model', file), src);

  beforeEach(async () => {
    root = project();
    schema = `efc_gen_${Math.random().toString(36).slice(2, 8)}`;
    const u = new URL(PG);
    u.searchParams.set('options', `-c search_path=${schema}`);
    url = u.toString();
    const client = new pg.Client(PG);
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.end();
    model(
      'User.js',
      `import { defineTable } from 'express-file-cluster';
export const User = defineTable('User', {
  email: { type: 'string', required: true, unique: true },
  role: { type: 'string', enum: ['member', 'admin'] },
});`,
    );
    model(
      'Post.js',
      `import { defineTable } from 'express-file-cluster';
export const Post = defineTable('Post', {
  title: { type: 'string', required: true },
  kind: { type: 'string', enum: ['note', 'link'], nativeEnum: true },
  author: { type: 'uuid', ref: 'User', onDelete: 'cascade' },
  readers: { type: 'array', of: 'uuid', ref: 'User' },
});`,
    );
  });

  afterEach(async () => {
    const client = new pg.Client(PG);
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    // A failed run could leave a shadow schema behind.
    const { rows } = await client.query<{ n: string }>(
      `SELECT nspname AS n FROM pg_namespace WHERE nspname LIKE 'efc_shadow_%'`,
    );
    for (const r of rows) await client.query(`DROP SCHEMA IF EXISTS "${r.n}" CASCADE`);
    await client.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a migration from the models, verifies it, applies it and reports no drift', async () => {
    const before = efc('db', 'generate', '--verify');
    expect(before.code).toBe(1);
    expect(before.out).toMatch(/don't match the models[\s\S]*CREATE TABLE IF NOT EXISTS "posts"/);

    const gen = efc('db', 'generate', 'init');
    expect(gen.code).toBe(0);
    expect(migrationFiles(root)).toEqual([expect.stringMatching(/^\d{14}_init\.js$/)]);
    const file = readMigration(root, 'init');
    // Tables before foreign keys, every step guarded or idempotent, a reverse for down().
    expect(file.indexOf('CREATE TABLE IF NOT EXISTS "users"')).toBeLessThan(
      file.indexOf('FOREIGN KEY ("author")'),
    );
    expect(file).toMatch(/CREATE TYPE "posts_kind_enum" AS ENUM \('note', 'link'\)`, skipIf:/);
    expect(file).toMatch(/export async function down[\s\S]*DROP TABLE IF EXISTS "posts_readers"/);

    expect(efc('db', 'generate', '--verify').out).toMatch(/Verified/);
    expect(efc('db', 'generate', 'again').out).toMatch(/No changes/);
    expect(migrationFiles(root)).toHaveLength(1);
    // Nothing touched the real schema yet: generate works on a throwaway one.
    expect(await sql(`SELECT to_regclass('posts') AS t`)).toEqual([{ t: null }]);

    expect(efc('db', 'migrate').out).toMatch(/Ran 1 migration/);
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(0);
    // Running it again over the existing tables (e.g. a baseline) changes nothing.
    await sql('DELETE FROM efc_migrations');
    expect(efc('db', 'migrate').code).toBe(0);
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(0);
  });

  it('renames, drops and tightens explicitly, behind row checks, and rolls back', async () => {
    expect(efc('db', 'generate', 'init').code).toBe(0);
    expect(efc('db', 'migrate').code).toBe(0);
    await sql(`INSERT INTO posts (title) VALUES ('kept'), (NULL)`);

    model(
      'Post.js',
      `import { defineTable } from 'express-file-cluster';
export const Post = defineTable('Post', {
  headline: { type: 'string', required: true, renamedFrom: 'title' },
  views: { type: 'integer' },
  author: { type: 'uuid', ref: 'User', onDelete: 'cascade' },
  readers: { type: 'array', of: 'uuid', ref: 'User' },
});`,
    );
    // The live database no longer matches: CI's drift check fails with exit code 2.
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(2);

    const gen = efc('db', 'generate', 'headline', '--allow-drop', '--tighten');
    expect(gen.code).toBe(0);
    const file = readMigration(root, 'headline');
    expect(file).toContain('RENAME COLUMN "title" TO "headline"');
    expect(file).toContain('DROP COLUMN IF EXISTS "kind"');
    expect(file).toContain('ALTER COLUMN "headline" SET NOT NULL');
    expect(file).toMatch(/down[\s\S]*RENAME COLUMN "headline" TO "title"/);

    // A NULL headline stops the migration; nothing is applied.
    const blocked = efc('db', 'migrate');
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(
      /Post\.headline is required, but 1 row\(s\) of "posts" have no value/,
    );
    expect(
      (
        await sql(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'posts' AND column_name = 'title'`,
        )
      ).length,
    ).toBe(1);

    await sql(`UPDATE posts SET title = 'filled' WHERE title IS NULL`);
    expect(efc('db', 'migrate').out).toMatch(/Ran 1 migration/);
    expect(await sql(`SELECT headline FROM posts ORDER BY headline`)).toEqual([
      { headline: 'filled' },
      { headline: 'kept' },
    ]);
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(0);
    expect(efc('db', 'generate', '--verify').out).toMatch(/Verified/);

    expect(efc('db', 'rollback').out).toMatch(/Rolled back 1 migration/);
    expect(await sql(`SELECT title FROM posts ORDER BY title`)).toEqual([
      { title: 'filled' },
      { title: 'kept' },
    ]);
  });

  it('migrate --baseline records migrations without running them', async () => {
    expect(efc('db', 'generate', 'init').code).toBe(0);
    expect(efc('db', 'migrate', '--baseline').out).toMatch(/mark\s+\d+_init[\s\S]*as applied/);
    expect(await sql(`SELECT to_regclass('posts') AS t`)).toEqual([{ t: null }]);
    expect(efc('db', 'status').out).toMatch(/✓ \d+_init batch 1/);
  });

  it('import-prisma → generate → migrate → pull round-trips with no diff', async () => {
    fs.rmSync(path.join(root, 'src', 'model'), { recursive: true });
    fs.mkdirSync(path.join(root, 'prisma'));
    fs.writeFileSync(
      path.join(root, 'prisma', 'schema.prisma'),
      `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

/// A blog author.
model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  name      String?   @db.VarChar(80)
  role      Role      @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  @@map("users")
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId Int    @unique
}

model Post {
  id         Int        @id @default(autoincrement())
  title      String
  published  Boolean    @default(false)
  price      Decimal?   @db.Decimal(10, 2)
  tags       String[]
  author     User       @relation(fields: [authorId], references: [id])
  authorId   Int
  categories Category[]
  createdAt  DateTime   @default(now())
  updatedAt  DateTime   @updatedAt
  @@index([authorId, createdAt(sort: Desc)])
}

model Category {
  id    BigInt @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
`,
    );
    const imported = cli(root, url, 'import-prisma');
    expect(imported.code).toBe(0);
    expect(imported.out).toMatch(/Imported 4 model\(s\)/);
    const post = fs.readFileSync(path.join(root, 'src', 'model', 'Post.js'), 'utf8');
    expect(post).toContain(
      "author: { type: 'integer', ref: 'User', required: true, column: 'authorId' }",
    );
    expect(post).toContain("id: 'serial'");
    expect(fs.readFileSync(path.join(root, 'src', 'model', 'User.js'), 'utf8')).toMatch(
      /profile: \{ hasOne: 'Profile', foreignKey: 'user' \}/,
    );

    expect(efc('db', 'generate', 'init', '--tighten').code).toBe(0);
    expect(efc('db', 'generate', '--verify').out).toMatch(/Verified/);
    expect(efc('db', 'migrate').code).toBe(0);
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(0);

    // Pull the schema back as models, swap them in: still nothing to change.
    const pulled = efc('db', 'pull', '--out', 'pulled');
    expect(pulled.out).toMatch(/Pulled 4 model\(s\)/);
    const pulledPost = fs.readFileSync(path.join(root, 'pulled', 'Post.js'), 'utf8');
    expect(pulledPost).toContain(
      "author: { type: 'integer', required: true, column: 'authorId', ref: 'User' }",
    );
    expect(pulledPost).toContain('indexes: [{ fields: { author: 1, createdAt: -1 } }]');
    expect(fs.readFileSync(path.join(root, 'pulled', 'Category.js'), 'utf8')).toContain(
      "posts: { type: 'array', of: 'integer', ref: 'Post' }",
    );
    fs.rmSync(path.join(root, 'src', 'model'), { recursive: true });
    fs.renameSync(path.join(root, 'pulled'), path.join(root, 'src', 'model'));
    expect(efc('db', 'generate', '--verify').out).toMatch(/Verified/);
    expect(efc('db', 'sync', '--dry-run', '--exit-code').code).toBe(0);
  });
});

describe.skipIf(!mongoUp)('efc db generate — mongodb', { timeout: 120_000 }, () => {
  let root: string;
  const efc = (...args: string[]) => cli(root, MONGO, 'db', ...args);
  const note = (field: string, extra = '') =>
    fs.writeFileSync(
      path.join(root, 'src', 'model', 'Note.js'),
      `import { defineModel } from 'express-file-cluster';
export const Note = defineModel('GenNote', {
  ${field}: { type: 'string', required: true, unique: true${extra} },
  body: { type: 'string', index: true },
}, { collection: 'gen_notes' });`,
    );

  beforeEach(() => {
    root = project();
    note('title');
  });

  afterEach(async () => {
    const conn = await mongoose.createConnection(MONGO).asPromise();
    await conn.dropDatabase();
    await conn.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates collections and indexes, and renames fields in stored documents once', async () => {
    expect(efc('generate', 'init').code).toBe(0);
    expect(readMigration(root, 'init')).toContain(
      'await db.collection("gen_notes").createIndex({"title":1}, {"unique":true,"name":"title_1"});',
    );
    expect(efc('generate', '--verify').out).toMatch(/Verified/);
    expect(efc('migrate').out).toMatch(/Ran 1 migration/);
    expect(efc('sync', '--dry-run', '--exit-code').code).toBe(0);

    const conn = await mongoose.createConnection(MONGO).asPromise();
    await conn.collection('gen_notes').insertMany([{ title: 'a' }, { title: 'b' }]);

    note('heading', ", renamedFrom: 'title'");
    expect(efc('generate', 'heading').code).toBe(0);
    const file = readMigration(root, 'heading');
    // Stale indexes go first (a unique one on the old name sees duplicate nulls), then the
    // rename, then the new index, which must see the moved values.
    expect(file.indexOf('dropIndex("title_1")')).toBeLessThan(file.indexOf('$rename'));
    expect(file.indexOf('$rename')).toBeLessThan(file.indexOf('createIndex({"heading":1}'));
    expect(efc('migrate').out).toMatch(/Ran 1 migration/);
    const docs = await conn
      .collection('gen_notes')
      .find({}, { projection: { _id: 0 } })
      .sort({ heading: 1 })
      .toArray();
    expect(docs).toEqual([{ heading: 'a' }, { heading: 'b' }]);
    await conn.close();

    // Written once: neither a new generate nor verify asks for the rename again.
    expect(efc('generate', 'again').out).toMatch(/No changes/);
    expect(efc('generate', '--verify').out).toMatch(/Verified/);
  });
});
