import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { defineTable } from '../../db/table-model.js';
import { setDbEngine } from '../../db/engine.js';
import { connectPostgres, closePostgres, getPool } from '../../db/postgres.js';
import { tableNameFor } from '../../db/pg-table.js';
import { onQuery, type QueryEvent } from '../../db/query-log.js';

// Runs the examples in docs/guides/relations.md, so the guide can't drift from the code.
// Skips without PostgreSQL.
const PG_URL = process.env['EFC_TEST_PG_URL'] ?? 'postgres://postgres@127.0.0.1:5433/efc_test';

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

const available = await reachablePg(PG_URL);
const s = Math.random().toString(36).slice(2, 7);
const tables: string[] = [];
const name = (base: string) => {
  const n = `${base}${s}`;
  tables.push(tableNameFor(n));
  return n;
};

const USER = name('GUser');
const PROFILE = name('GProfile');
const TAG = name('GTag');
const POST = name('GPost');
const COMMENT = name('GComment');

const User = defineTable(
  USER,
  {
    email: { type: 'string', required: true, unique: true },
    role: { type: 'string', enum: ['user', 'admin'], default: 'user' },
  },
  {
    relations: {
      posts: { hasMany: POST, foreignKey: 'author' },
      profile: { hasOne: PROFILE, foreignKey: 'user' },
    },
  },
);
const Profile = defineTable(PROFILE, {
  user: { type: 'uuid', ref: USER, required: true, unique: true, onDelete: 'cascade' },
  bio: { type: 'string' },
});
const Tag = defineTable(
  TAG,
  { label: { type: 'string', required: true, unique: true } },
  { relations: { posts: { hasMany: POST, foreignKey: 'tags' } } },
);
const Post = defineTable(
  POST,
  {
    title: { type: 'string', required: true },
    published: { type: 'boolean', default: false },
    author: { type: 'uuid', ref: USER, required: true, onDelete: 'cascade' },
    tags: { type: 'array', of: 'uuid', ref: TAG },
  },
  { relations: { comments: { hasMany: COMMENT, foreignKey: 'post' } } },
);
const Comment = defineTable(COMMENT, {
  post: { type: 'uuid', ref: POST, required: true, onDelete: 'cascade' },
  body: { type: 'string', required: true },
  approved: { type: 'boolean', default: false },
});

type Row = Record<string, unknown>;

describe.skipIf(!available)('docs/guides/relations.md', () => {
  beforeAll(async () => {
    setDbEngine('postgresql');
    await connectPostgres(PG_URL);
    for (const m of [User, Profile, Tag, Post, Comment]) await m.sync();
  });

  afterAll(async () => {
    for (const t of [...tables, `${tableNameFor(POST)}_tags`]) {
      await getPool()
        .query(`DROP TABLE IF EXISTS "${t}" CASCADE`)
        .catch(() => {});
    }
    await closePostgres();
  });

  it('runs every example in the guide', async () => {
    const ann = await User.create({ data: { email: 'ann@example.com', role: 'admin' } });
    const bob = await User.create({ data: { email: 'bob@example.com' } });
    const launch = await Tag.create({ data: { label: 'launch' } });

    // Writing through relations
    const post = (await Post.create({
      data: {
        title: 'Hello',
        author: { connect: { email: 'ann@example.com' } },
        tags: { connectOrCreate: [{ where: { label: 'news' }, create: { label: 'news' } }] },
        comments: { create: [{ body: 'First!' }] },
      },
      include: { tags: true, comments: true },
    })) as unknown as Row & { tags: Row[]; comments: Row[] };
    expect(post['author']).toBe(ann.id);
    expect(post.tags.map((t) => t['label'])).toEqual(['news']);
    expect(post.comments.map((c) => c['body'])).toEqual(['First!']);

    await Post.update({ where: { id: post['id'] as string }, data: { tags: { push: launch.id } } });
    expect((await Post.findUnique({ where: { id: post['id'] as string } }))?.tags).toHaveLength(2);
    await Post.update({ where: { id: post['id'] as string }, data: { tags: { set: [] } } });
    expect((await Post.findUnique({ where: { id: post['id'] as string } }))?.tags).toEqual([]);

    await Post.create({ data: { title: 'Draft', author: bob.id } });
    await Post.create({
      data: { title: 'Live', published: true, author: bob.id, tags: [launch.id] },
    });
    await User.update({
      where: { id: bob.id },
      data: {
        profile: { create: { bio: 'Writes about Postgres' } },
        posts: { deleteMany: { published: false } },
      },
    });
    expect((await Post.findMany({ where: { author: bob.id } })).map((p) => p.title)).toEqual([
      'Live',
    ]);

    // Profile.user is required: a second profile can't unlink the first, `delete: true` replaces it
    await expect(
      User.update({ where: { id: bob.id }, data: { profile: { create: { bio: 'v2' } } } }),
    ).rejects.toThrow("can't be unlinked — add delete: true to replace it");
    await User.update({
      where: { id: bob.id },
      data: { profile: { delete: true, create: { bio: 'Writes about Postgres' } } },
    });
    expect((await Profile.findMany({ where: { user: bob.id } })).map((p) => p.bio)).toEqual([
      'Writes about Postgres',
    ]);

    // Reading with include: one statement
    const events: QueryEvent[] = [];
    const off = onQuery((e) => events.push(e));
    const read = (await Post.findUnique({
      where: { id: post['id'] as string },
      include: {
        author: { select: { email: true } },
        tags: true,
        comments: { where: { approved: false }, orderBy: { createdAt: 'desc' }, take: 10 },
      },
    })) as unknown as Row & { author: Row; comments: Row[] };
    off();
    expect(read.author).toEqual({ email: 'ann@example.com' });
    expect(read.comments).toHaveLength(1);
    expect(events.map((e) => e.statements)).toEqual([1]);

    const users = (await User.findMany({
      where: { id: bob.id },
      include: { profile: true, posts: { where: { published: true }, include: { tags: true } } },
    })) as unknown as (Row & { profile: Row; posts: (Row & { tags: Row[] })[] })[];
    expect(users[0]!.profile['bio']).toBe('Writes about Postgres');
    expect(users[0]!.posts[0]!.tags.map((t) => t['label'])).toEqual(['launch']);

    // Filtering by relation
    const carl = await User.create({ data: { email: 'carl@example.com' } });
    const emails = (rows: { email: string }[]) => rows.map((r) => r.email).sort();
    expect(
      emails(await User.findMany({ where: { posts: { some: { published: true } } } })),
    ).toEqual(['bob@example.com']);
    expect(emails(await User.findMany({ where: { posts: { none: {} } } }))).toEqual([
      'carl@example.com',
    ]);
    expect(
      (await Post.findMany({ where: { author: { is: { role: 'admin' } } } })).map((p) => p.title),
    ).toEqual(['Hello']);
    expect(
      (await Post.findMany({ where: { comments: { some: { approved: false } } } })).map(
        (p) => p.title,
      ),
    ).toEqual(['Hello']);
    expect(
      (await Post.findMany({ where: { tags: { has: launch.id } } })).map((p) => p.title),
    ).toEqual(['Live']);
    expect(
      (await Post.findMany({ where: { tags: { every: { label: { startsWith: 'la' } } } } }))
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Hello', 'Live']); // `every` holds for a post with no tags

    // A connect that matches nothing is a 400 on the field
    await expect(
      Post.create({ data: { title: 'X', author: { connect: { email: 'nobody@example.com' } } } }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Deleting cascades: profile, posts, and through posts the comments
    await User.delete({ where: { id: ann.id } });
    expect(await Post.count({ where: { title: 'Hello' } })).toBe(0);
    expect(await Comment.count()).toBe(0);
    await User.delete({ where: { id: bob.id } });
    expect(await Profile.count()).toBe(0);
    await User.delete({ where: { id: carl.id } });
  });
});
