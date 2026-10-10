import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

// `efc db migrate | rollback | status | seed | studio` through the real CLI binary,
// in a throwaway project that resolves `express-file-cluster` via node_modules like an
// installed app. Needs the built dist/ and a reachable database per engine.
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(CORE, 'dist', 'cli', 'index.js');
const URLS = {
  mongodb: process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_db_cli_test',
  postgresql: process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test',
};

async function reachable(engine: keyof typeof URLS): Promise<boolean> {
  if (engine === 'mongodb') {
    const conn = mongoose.createConnection(URLS.mongodb, { serverSelectionTimeoutMS: 1500 });
    return conn.asPromise().then(
      () => conn.close().then(() => true),
      () => false,
    );
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: URLS.postgresql,
    connectionTimeoutMillis: 1500,
  });
  return client.connect().then(
    () => client.end().then(() => true),
    () => false,
  );
}

const available = {
  mongodb: await reachable('mongodb'),
  postgresql: await reachable('postgresql'),
};

for (const engine of ['mongodb', 'postgresql'] as const) {
  describe.skipIf(!fs.existsSync(CLI) || !available[engine])(`efc db — ${engine}`, () => {
    let root: string;
    const table = `efc_cli_notes_${Math.random().toString(36).slice(2, 7)}`;
    const efc = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, 'db', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: URLS[engine], NO_COLOR: '1' },
      });

    const migration = (file: string, up: string, down: string) =>
      fs.writeFileSync(
        path.join(root, 'src', 'migrations', file),
        `import { defineModel } from 'express-file-cluster';
export const Note = defineModel('CliNote', { title: { type: 'string', required: true }, pinned: { type: 'boolean' } }, { collection: '${table}' });
export async function up({ db, engine }) { ${up} }
export async function down({ db, engine }) { ${down} }
`,
      );

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-db-cli-'));
      fs.mkdirSync(path.join(root, 'src', 'migrations'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src', 'seeds'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.symlinkSync(CORE, path.join(root, 'node_modules', 'express-file-cluster'), 'dir');
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'cli-app', type: 'module' }),
      );
    });

    afterEach(async () => {
      if (engine === 'mongodb') {
        const conn = await mongoose.createConnection(URLS.mongodb).asPromise();
        await conn.dropDatabase();
        await conn.close();
      } else {
        const { default: pg } = await import('pg');
        const client = new pg.Client(URLS.postgresql);
        await client.connect();
        await client.query(`DROP TABLE IF EXISTS "${table}"; DROP TABLE IF EXISTS efc_migrations`);
        await client.end();
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('migrates in batches, reports status, seeds, and rolls back batch by batch', async () => {
      const drop =
        engine === 'postgresql'
          ? `await db.query('DROP TABLE IF EXISTS "${table}"');`
          : `await db.dropCollection('${table}').catch(() => {});`;
      migration('20260101000000_create_notes.js', 'await Note.sync();', drop);
      expect(efc('migrate')).toMatch(/up\s+20260101000000_create_notes[\s\S]*Ran 1 migration/);
      expect(efc('migrate')).toMatch(/Nothing to migrate/);

      migration(
        '20260102000000_welcome_note.js',
        "await Note.create({ title: 'welcome', pinned: true });",
        "await Note.deleteMany({ title: 'welcome' });",
      );
      fs.writeFileSync(
        path.join(root, 'src', 'seeds', 'demo.js'),
        `import { Note } from '../migrations/20260101000000_create_notes.js';
export default async function seed() { await Note.createMany([{ title: 'a' }, { title: 'b' }]); }`,
      );

      expect(efc('status')).toMatch(
        /✓ 20260101000000_create_notes batch 1[\s\S]*• 20260102000000_welcome_note pending/,
      );
      expect(efc('migrate')).toMatch(/Ran 1 migration/);
      expect(efc('status')).toMatch(/20260102000000_welcome_note batch 2/);
      expect(efc('seed', 'demo')).toMatch(/seed demo[\s\S]*Ran 1 seed/);

      const titles = async () => {
        if (engine === 'mongodb') {
          const conn = await mongoose.createConnection(URLS.mongodb).asPromise();
          const docs = await conn
            .collection(table)
            .find()
            .toArray()
            .catch(() => []);
          await conn.close();
          return docs.map((d) => d['title'] as string).sort();
        }
        const { default: pg } = await import('pg');
        const client = new pg.Client(URLS.postgresql);
        await client.connect();
        const rows = await client.query(`SELECT title FROM "${table}" ORDER BY title`).then(
          (r) => r.rows.map((x: { title: string }) => x.title),
          () => null,
        );
        await client.end();
        return rows;
      };
      expect(await titles()).toEqual(['a', 'b', 'welcome']);

      expect(efc('rollback')).toMatch(/down 20260102000000_welcome_note[\s\S]*Rolled back 1/);
      expect(await titles()).toEqual(['a', 'b']);
      expect(efc('status')).toMatch(/• 20260102000000_welcome_note pending/);

      expect(efc('rollback')).toMatch(/down 20260101000000_create_notes/);
      expect(await titles()).toEqual(engine === 'mongodb' ? [] : null);
      expect(efc('rollback')).toMatch(/Nothing to roll back/);
    }, 60_000);

    it('fails with a non-zero exit when a migration throws, recording nothing', () => {
      migration('20260101000000_broken.js', "throw new Error('boom in up');", '');
      let out = '';
      let code = 0;
      try {
        efc('migrate');
      } catch (err) {
        const e = err as { status: number; stderr: string; stdout: string };
        code = e.status;
        out = e.stderr + e.stdout;
      }
      expect(code).toBe(1);
      expect(out).toMatch(/boom in up/);
      expect(efc('status')).toMatch(/• 20260101000000_broken pending/);
    }, 30_000);

    it('serves a read-only studio', async () => {
      migration(
        '20260101000000_create_notes.js',
        "await Note.sync(); await Note.create({ title: 'visible' });",
        '',
      );
      efc('migrate');
      const child = spawn(process.execPath, [CLI, 'db', 'studio', '--port', '0'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: URLS[engine], NO_COLOR: '1' },
      });
      try {
        const url = await new Promise<string>((resolve, reject) => {
          let out = '';
          const timer = setTimeout(() => reject(new Error('studio did not start: ' + out)), 15_000);
          child.stdout.on('data', (d: Buffer) => {
            out += d.toString();
            const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
            if (m) {
              clearTimeout(timer);
              resolve(m[0]);
            }
          });
        });
        const cols = (await (await fetch(`${url}/api/collections`)).json()) as {
          engine: string;
          collections: { name: string; count: number }[];
        };
        expect(cols.engine).toBe(engine);
        expect(cols.collections).toEqual(expect.arrayContaining([{ name: table, count: 1 }]));
        const page = (await (await fetch(`${url}/api/collections/${table}`)).json()) as {
          rows: { title: string }[];
          total: number;
        };
        expect(page.total).toBe(1);
        expect(page.rows[0]!.title).toBe('visible');
        expect((await fetch(`${url}/api/collections/${table}`, { method: 'POST' })).status).toBe(
          405,
        );
        expect((await fetch(url)).headers.get('content-type')).toMatch(/text\/html/);
        // DNS-rebinding guard: a non-loopback Host header is refused.
        const { request: httpRequest } = await import('node:http');
        const rebound = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            `${url}/api/collections`,
            { headers: { host: 'evil.example:4983' } },
            (r) => {
              r.resume();
              resolve(r.statusCode ?? 0);
            },
          );
          req.once('error', reject);
          req.end();
        });
        expect(rebound).toBe(403);
      } finally {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
    }, 30_000);
  });
}
