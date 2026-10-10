import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { defineModel } from '../../db/model.js';
import { setDbEngine } from '../../db/engine.js';
import { connectPostgres, closePostgres, getPool } from '../../db/postgres.js';
import { tableNameFor } from '../../db/pg-model.js';
import { transaction } from '../../db/transaction.js';
import { ModelValidationError } from '../../db/schema.js';
import { HttpError } from '../../errors.js';
import { runWithContext } from '../../context.js';
import type { DatabaseEngine, ModelCRUD } from '../../types.js';

// One conformance suite, run against every engine that is reachable: defineModel must
// behave the same on MongoDB and PostgreSQL. Each engine block skips itself when its
// database isn't available (CI provides both).
const MONGO_URL = process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_engines_test';
// Transactions need a replica set; a standalone mongod can't run them.
const MONGO_RS_URL =
  process.env['EFC_TEST_MONGO_RS_URL'] ??
  'mongodb://127.0.0.1:27018/efc_engines_tx?replicaSet=rs0&directConnection=true';
const PG_URL = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test';

async function reachableMongo(url: string): Promise<boolean> {
  const conn = mongoose.createConnection(url, { serverSelectionTimeoutMS: 1500 });
  try {
    await conn.asPromise();
    return true;
  } catch {
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function reachablePg(url: string): Promise<boolean> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const available: Record<DatabaseEngine, boolean> = {
  mongodb: await reachableMongo(MONGO_URL),
  postgresql: await reachablePg(PG_URL),
};
const mongoTx = available.mongodb && (await reachableMongo(MONGO_RS_URL));

interface Author {
  name: string;
}
interface Book {
  title: string;
  pages: number;
  genre: string;
  tags: string[];
  isbn: string;
  author: string;
  coAuthors: string[];
  publisher: { name: string; city?: string; founded?: number };
  chapters: { title: string; words: number }[];
  serial: number;
  token: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
  stock: number;
}

for (const engine of ['mongodb', 'postgresql'] as const) {
  describe.skipIf(!available[engine])(`defineModel conformance — ${engine}`, () => {
    const suffix = `${engine === 'mongodb' ? 'M' : 'P'}${Math.random().toString(36).slice(2, 7)}`;
    let Author: ModelCRUD<Author>;
    let Book: ModelCRUD<Book>;

    beforeAll(async () => {
      setDbEngine(engine);
      if (engine === 'mongodb') await mongoose.connect(mongoTx ? MONGO_RS_URL : MONGO_URL);
      else await connectPostgres(PG_URL);

      Author = defineModel<Author>(`Author${suffix}`, { name: { type: 'string', required: true } });
      Book = defineModel<Book>(
        `Book${suffix}`,
        {
          title: { type: 'string', required: true, minLength: 2, maxLength: 80 },
          pages: { type: 'number', min: 1, max: 5000 },
          genre: { type: 'string', enum: ['fiction', 'science', 'history'], default: 'fiction' },
          tags: { type: 'array', of: 'string', default: [] },
          isbn: { type: 'string', unique: true, match: /^\d{3}-\d{4}$/ },
          author: { type: 'objectId', ref: `Author${suffix}` },
          coAuthors: { type: 'array', of: 'objectId', ref: `Author${suffix}` },
          publisher: {
            name: { type: 'string', required: true },
            city: { type: 'string' },
            founded: { type: 'number', min: 1400 },
          },
          chapters: [{ title: { type: 'string', required: true }, words: { type: 'number' } }],
          serial: { type: 'number', sequence: true },
          token: { type: 'string', default: '$uuid' },
          createdBy: { type: 'string', default: '$currentUser.id' },
          meta: { type: 'object' },
          stock: {
            type: 'number',
            default: 0,
            validate: (v) => (v as number) >= 0 || 'stock cannot go negative',
          },
        },
        { indexes: [{ fields: { genre: 1, pages: -1 } }] },
      );
      await Author.sync();
      await Book.sync();
      await Book.sync(); // idempotent
    });

    afterAll(async () => {
      if (engine === 'mongodb') {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      } else {
        for (const model of [Book, Author]) {
          await getPool().query(`DROP TABLE IF EXISTS "${tableNameFor(model.name)}"`);
        }
        await closePostgres();
      }
    });

    const base = (n: number, extra: Partial<Book> = {}): Partial<Book> => ({
      title: `Book ${n}`,
      pages: n * 100,
      isbn: `${String(n).padStart(3, '0')}-${String(1000 + n)}`,
      publisher: { name: 'Acme', city: n % 2 ? 'Oslo' : 'Lima' },
      ...extra,
    });

    it('creates records with defaults, sequences and a normalised string id', async () => {
      const b = await runWithContext({ user: { id: 'u-1' } }, () =>
        Book.create(base(1, { tags: ['a'] })),
      );
      expect(typeof b.id).toBe('string');
      expect(b.genre).toBe('fiction');
      expect(b.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(b.createdBy).toBe('u-1');
      expect(b.stock).toBe(0);
      expect(typeof b.serial).toBe('number');
      expect((b as unknown as { createdAt: Date }).createdAt).toBeInstanceOf(Date);

      const b2 = await Book.create(base(2));
      expect(b2.serial).toBe(b.serial + 1);
      expect(b2.createdBy).toBeUndefined();
      expect(await Book.findById(b.id)).toMatchObject({
        title: 'Book 1',
        publisher: { name: 'Acme', city: 'Oslo' },
      });
    });

    it('returns null (not an error) for malformed and unknown ids', async () => {
      expect(await Book.findById('not-an-id')).toBeNull();
      expect(await Book.update('not-an-id', { pages: 3 })).toBeNull();
      await expect(Book.delete('not-an-id')).resolves.toBeUndefined();
    });

    it('validates fields, embedded objects and array items with a 400 ModelValidationError', async () => {
      const err = await Book.create({
        title: 'x',
        pages: 0,
        genre: 'poetry',
        isbn: 'bad',
        publisher: { founded: 1200 } as Book['publisher'],
        chapters: [{ words: 10 } as Book['chapters'][number]],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelValidationError);
      expect((err as ModelValidationError).statusCode).toBe(400);
      const paths = (err as ModelValidationError).issues.map((i) => i.path).sort();
      expect(paths).toEqual(
        expect.arrayContaining([
          'chapters.0.title',
          'genre',
          'isbn',
          'pages',
          'publisher.founded',
          'publisher.name',
          'title',
        ]),
      );
    });

    it('runs custom validators with their message', async () => {
      const err = await Book.create(base(3, { stock: -1 })).catch((e: unknown) => e);
      expect((err as ModelValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'stock', message: 'stock cannot go negative' }),
        ]),
      );
    });

    it('update() validates changed fields and supports $inc, $push, $pull, $unset', async () => {
      const b = await Book.create(base(4, { tags: ['x'] }));
      await expect(Book.update(b.id, { genre: 'poetry' })).rejects.toBeInstanceOf(
        ModelValidationError,
      );
      await expect(Book.update(b.id, { title: null as unknown as string })).rejects.toBeInstanceOf(
        ModelValidationError,
      );

      const before = (b as unknown as { updatedAt: Date }).updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      const u = await Book.update(b.id, {
        $inc: { stock: 5 },
        $push: { tags: 'y' },
        $set: { genre: 'science' },
      });
      expect(u).toMatchObject({ stock: 5, tags: ['x', 'y'], genre: 'science' });
      expect((u as unknown as { updatedAt: Date }).updatedAt.getTime()).toBeGreaterThan(
        before.getTime(),
      );

      const pulled = await Book.update(b.id, { $pull: { tags: 'x' }, $unset: { meta: true } });
      expect(pulled?.tags).toEqual(['y']);
      expect(await Book.update(b.id, { 'publisher.city': 'Rome' } as never)).toMatchObject({
        publisher: { city: 'Rome' },
      });
    });

    it('filters with operators, dotted paths, array containment, $or and $exists', async () => {
      await Book.deleteMany({});
      await Book.createMany([
        base(10, { genre: 'science', tags: ['space', 'math'], meta: { featured: true } }),
        base(11, { genre: 'history', tags: ['war'] }),
        base(12, { genre: 'science', tags: ['bio'] }),
      ]);
      const titles = async (f: object) =>
        (await Book.find(f as never, { sort: { pages: 1 } })).map((b) => b.title);

      expect(await titles({ pages: { $gte: 1100 } })).toEqual(['Book 11', 'Book 12']);
      expect(await titles({ genre: { $in: ['history'] } })).toEqual(['Book 11']);
      expect(await titles({ genre: { $ne: 'science' } })).toEqual(['Book 11']);
      expect(await titles({ title: { $regex: /book 1[02]/i } })).toEqual(['Book 10', 'Book 12']);
      expect(await titles({ tags: 'math' })).toEqual(['Book 10']);
      expect(await titles({ 'publisher.city': 'Lima' })).toEqual(['Book 10', 'Book 12']);
      expect(await titles({ $or: [{ genre: 'history' }, { pages: 1200 }] })).toEqual([
        'Book 11',
        'Book 12',
      ]);
      expect(await titles({ meta: { $exists: true } })).toEqual(['Book 10']);
      expect(await Book.count({ genre: 'science' })).toBe(2);
    });

    it('supports sort, limit, skip and select', async () => {
      const page = await Book.find(
        {},
        { sort: { pages: -1 }, skip: 1, limit: 1, select: ['title'] },
      );
      expect(page).toHaveLength(1);
      expect(page[0]!.title).toBe('Book 11');
      expect(page[0]!.id).toBeDefined();
      expect(page[0]!.pages).toBeUndefined();
    });

    it('updateMany / deleteMany return counts', async () => {
      expect(await Book.updateMany({ genre: 'science' }, { $set: { stock: 9 } })).toBe(2);
      expect(await Book.count({ stock: 9 })).toBe(2);
      expect(await Book.deleteMany({ genre: 'history' })).toBe(1);
      expect(await Book.count()).toBe(2);
    });

    it('rejects duplicates of a unique field with 409', async () => {
      await Book.create(base(20));
      const err = await Book.create(base(20)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).message).toMatch(/isbn/);
    });

    it('populates single and array refs', async () => {
      const a1 = await Author.create({ name: 'Ada' });
      const a2 = await Author.create({ name: 'Bo' });
      const b = await Book.create(base(30, { author: a1.id, coAuthors: [a2.id, a1.id] }));
      const found = await Book.findById(b.id, { populate: ['author', 'coAuthors'] });
      expect((found!.author as unknown as Author & { id: string }).name).toBe('Ada');
      expect((found!.author as unknown as { id: string }).id).toBe(a1.id);
      expect((found!.coAuthors as unknown as Author[]).map((a) => a.name)).toEqual(['Bo', 'Ada']);
      expect(String((await Book.findById(b.id))!.author)).toBe(a1.id);
    });

    it.skipIf(engine === 'mongodb' && !mongoTx)('commits and rolls back transactions', async () => {
      const before = await Book.count();
      await transaction(async () => {
        await Book.create(base(40));
        await Book.create(base(41));
      });
      expect(await Book.count()).toBe(before + 2);

      await expect(
        transaction(async () => {
          await Book.create(base(42));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await Book.count()).toBe(before + 2);
      expect(await Book.findOne({ isbn: '042-1042' })).toBeNull();
    });

    it('handles edge filters and dotted updates the same way', async () => {
      const Edge = defineModel<{
        tags: string[];
        at: Date;
        n: number;
        meta: { counts?: { views?: number }; note?: string; list?: string[] };
      }>(`Edge${suffix}`, {
        tags: { type: 'array', of: 'string' },
        at: { type: 'date' },
        n: { type: 'number' },
        meta: {
          counts: { views: { type: 'number', min: 0 } },
          note: { type: 'string', required: true },
          list: { type: 'array', of: 'string' },
        },
      });
      await Edge.sync();
      const a = await Edge.create({
        tags: ['x', 'y'],
        at: new Date('2026-01-01'),
        n: 1,
        meta: { note: 'hi' },
      });
      await Edge.create({ tags: ['z'], at: new Date('2026-06-01'), n: 2, meta: { note: 'yo' } });
      const count = (f: object) => Edge.count(f as never);

      expect(await count({ tags: { $ne: 'x' } })).toBe(1);
      expect(await count({ tags: { $nin: ['x', 'q'] } })).toBe(1);
      expect(await count({ at: { $gt: '2026-03-01' } })).toBe(1);
      expect(await count({ at: '2026-01-01T00:00:00.000Z' })).toBe(1);

      // Missing parents are created; several dotted writes to one object compose.
      const u = await Edge.update(a.id, {
        $set: { 'meta.counts.views': 5, 'meta.list': ['a'] },
        $inc: { n: 1 },
      } as never);
      expect(u).toMatchObject({ n: 2, meta: { note: 'hi', counts: { views: 5 }, list: ['a'] } });

      const v = await Edge.update(a.id, {
        $inc: { 'meta.counts.views': 2 },
        $push: { 'meta.list': { $each: ['b', 'c'] } },
      } as never);
      expect(v).toMatchObject({ meta: { counts: { views: 7 }, list: ['a', 'b', 'c'] } });

      const w = await Edge.update(a.id, { $pull: { 'meta.list': 'b' } } as never);
      expect(w?.meta.list).toEqual(['a', 'c']);

      // Dotted writes are validated against the nested schema.
      await expect(
        Edge.update(a.id, { $set: { 'meta.counts.views': -1 } } as never),
      ).rejects.toBeInstanceOf(ModelValidationError);
      await expect(
        Edge.update(a.id, { $unset: { 'meta.note': true } } as never),
      ).rejects.toBeInstanceOf(ModelValidationError);
      expect((await Edge.findById(a.id))?.meta.note).toBe('hi');
      await Edge.drop();
    });

    it('drop() removes the collection/table and is safe to repeat', async () => {
      const Temp = defineModel<{ x: string }>(`Temp${suffix}`, { x: { type: 'string' } });
      await Temp.sync();
      await Temp.create({ x: 'a' });
      await Temp.drop();
      await Temp.drop();
      await Temp.sync();
      expect(await Temp.count()).toBe(0);
      await Temp.drop();
    });

    it('exposes the native model/table via raw(), and aggregate() per engine', async () => {
      expect(await Book.raw()).toBeTruthy();
      if (engine === 'mongodb') {
        const rows = await Book.aggregate<{ _id: string; n: number }>([
          { $group: { _id: '$genre', n: { $sum: 1 } } },
        ]);
        expect(rows.length).toBeGreaterThan(0);
      } else {
        await expect(Book.aggregate([])).rejects.toThrow(/MongoDB-only/);
      }
    });
  });
}

describe.skipIf(!available.postgresql)('PostgreSQL sync()', () => {
  beforeAll(async () => {
    setDbEngine('postgresql');
    await connectPostgres(PG_URL);
  });
  afterAll(async () => {
    await getPool().query('DROP TABLE IF EXISTS "efc_sync_widgets"');
    await closePostgres();
  });

  it('adds columns for fields added after the table exists, without touching data', async () => {
    const V1 = defineModel<{ name: string }>(
      'SyncWidgetV1',
      { name: { type: 'string', required: true } },
      { collection: 'efc_sync_widgets' },
    );
    await V1.sync();
    await V1.create({ name: 'old' });

    const V2 = defineModel<{ name: string; color?: string }>(
      'SyncWidgetV2',
      { name: { type: 'string', required: true }, color: { type: 'string', default: 'red' } },
      { collection: 'efc_sync_widgets' },
    );
    await V2.sync();
    expect(await V2.find({}, { sort: { name: 1 } })).toMatchObject([{ name: 'old' }]);
    expect(await V2.create({ name: 'new' })).toMatchObject({ name: 'new', color: 'red' });
  });
});

describe.skipIf(!available.postgresql)('PostgreSQL through ignite()', () => {
  it('connects in Pre-Flight, exposes db as the pg Pool, and maps model errors to 400/409', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { default: request } = await import('supertest');
    const { ignite } = await import('../../index.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-pg-ignite-'));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexModule = JSON.stringify(path.resolve(here, '../../index.ts'));
    fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'api', 'notes.js'),
      `import { defineModel, db } from ${indexModule};
const Note = defineModel('IgniteNote', { slug: { type: 'string', required: true, unique: true } }, { collection: 'efc_ignite_notes' });
let synced;
export const POST = async (req, res) => {
  await (synced ??= Note.sync());
  res.status(201).json(await Note.create(req.body));
};
export const GET = async (_req, res) => {
  const { rows } = await db.query('select count(*)::int as n from efc_ignite_notes');
  res.json(rows[0]);
};`,
    );
    const cwd = process.cwd();
    process.chdir(root);
    const server = await ignite({
      basePath: '/',
      cluster: false,
      port: 0,
      logging: false,
      database: 'postgresql',
      databaseUrl: PG_URL,
    });
    try {
      expect((await request(server!).post('/notes').send({ slug: 'a' })).status).toBe(201);
      const dup = await request(server!).post('/notes').send({ slug: 'a' });
      expect(dup.status).toBe(409);
      const invalid = await request(server!).post('/notes').send({});
      expect(invalid.status).toBe(400);
      expect(invalid.body.issues).toEqual([{ path: 'slug', message: 'is required' }]);
      expect((await request(server!).get('/notes')).body).toEqual({ n: 1 });
    } finally {
      server!.closeAllConnections();
      await new Promise((r) => server!.close(r));
      await getPool().query('DROP TABLE IF EXISTS efc_ignite_notes');
      await closePostgres();
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
