# Relations

This guide builds a small blog schema with `defineTable` (PostgreSQL): users, profiles, posts, comments and tags. It covers each relation kind and how to read, filter and write through it. For every option, see the [`defineTable` reference](../api-reference/table.md#foreign-keys).

---

## The schema

```ts
// src/model/index.ts
import { defineTable } from 'express-file-cluster';

export const User = defineTable('User', {
  email: { type: 'string', required: true, unique: true },
  role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
}, {
  relations: {
    posts:   { hasMany: 'Post', foreignKey: 'author' },      // the other side of Post.author
    profile: { hasOne: 'Profile', foreignKey: 'user' },      // Profile.user is unique
  },
});

export const Profile = defineTable('Profile', {
  user: { type: 'uuid', ref: 'User', required: true, unique: true, onDelete: 'cascade' },
  bio:  { type: 'string' },
});

export const Tag = defineTable('Tag', {
  label: { type: 'string', required: true, unique: true },
}, {
  relations: { posts: { hasMany: 'Post', foreignKey: 'tags' } },
});

export const Post = defineTable('Post', {
  title:     { type: 'string', required: true },
  published: { type: 'boolean', default: false },
  author:    { type: 'uuid', ref: 'User', required: true, onDelete: 'cascade' },   // belongs to
  tags:      { type: 'array', of: 'uuid', ref: 'Tag' },                            // many-to-many
}, {
  relations: { comments: { hasMany: 'Comment', foreignKey: 'post' } },
});

export const Comment = defineTable('Comment', {
  post:     { type: 'uuid', ref: 'Post', required: true, onDelete: 'cascade' },
  body:     { type: 'string', required: true },
  approved: { type: 'boolean', default: false },
});

// typed includes: register the models once
declare module 'express-file-cluster' {
  interface Tables {
    User: typeof User; Profile: typeof Profile; Tag: typeof Tag; Post: typeof Post; Comment: typeof Comment;
  }
}
```

What each piece creates on the first sync:

| Declared | In the database |
|---|---|
| `author: { type: 'uuid', ref: 'User' }` | an `author` column, a foreign key to `users(id)`, an index |
| `tags: { type: 'array', of: 'uuid', ref: 'Tag' }` | a join table `posts_tags` (`owner_id`, `ref_id`, `position`), cascading both ways |
| `relations: { posts: { hasMany … } }` | nothing: it reads `Post.author` from the other side |
| `relations: { profile: { hasOne … } }` | nothing, but `Profile.user` must be `unique` |

Records hold ids, not objects: `post.author` is a string and `post.tags` is a `string[]`. `include` swaps them for records when you ask.

## Reading with `include`

```ts
const post = await Post.findUnique({
  where: { id },
  include: {
    author: { select: { email: true } },
    tags: true,
    comments: { where: { approved: true }, orderBy: { createdAt: 'desc' }, take: 10 },
  },
});
// { id, title, …, author: { email }, tags: [{ id, label, … }], comments: [{ … }] }

const users = await User.findMany({
  include: { profile: true, posts: { where: { published: true }, include: { tags: true } } },
});
```

However deep the `include` goes, the call runs **one SQL statement**. Turn on `logging.queries` to see the statement count per call.

## Filtering by relation

```ts
await User.findMany({ where: { posts: { some: { published: true } } } });             // has a published post
await User.findMany({ where: { posts: { none: {} } } });                              // no posts at all
await Post.findMany({ where: { author: { is: { role: 'admin' } } } });                // by an admin
await Post.findMany({ where: { tags: { every: { label: { startsWith: 'pub-' } } } } });
await Post.findMany({ where: { comments: { some: { approved: false } } } });          // needs moderation
await Post.findMany({ where: { tags: { has: tagId } } });                             // by id, no join
```

To-many relations take `some` / `every` / `none`. To-one relations take `is` / `isNot` (or `null`). They nest, and work anywhere `where` does: `count`, `updateMany`, `deleteMany`, and inside `include`.

## Writing through relations

```ts
// create a post, connect its author, create or connect tags, add a first comment: one transaction
const post = await Post.create({
  data: {
    title: 'Hello',
    author: { connect: { email: 'ann@example.com' } },
    tags: { connectOrCreate: [{ where: { label: 'news' }, create: { label: 'news' } }] },
    comments: { create: [{ body: 'First!' }] },
  },
  include: { tags: true, comments: true },
});

await Post.update({ where: { id: post.id }, data: { tags: { push: launchTagId } } });
await Post.update({ where: { id: post.id }, data: { tags: { set: [] } } });

await User.update({
  where: { id: userId },
  data: {
    profile: { create: { bio: 'Writes about Postgres' } },          // has one already? add delete: true
    posts: { deleteMany: { published: false } },                    // drop their drafts
  },
});
```

A `connect` that matches nothing is a **400** on that field, and nothing is written. A `hasOne` `create` or `connect` unlinks the current profile, if there is one. `Profile.user` is required, so here it can't be unlinked: write `profile: { delete: true, create: { … } }` to replace it. `createMany` and `updateMany` don't take nested writes.

## Deleting

`onDelete` on the ref field decides what happens to the records pointing at a deleted one:

```ts
await User.delete({ where: { id } });   // cascades: profile, posts, and (through posts) comments go too
```

With the default `onDelete: 'restrict'` the same delete would be a **409** while posts still point at the user. `'setNull'` clears the field instead, so it can't be used on `required` fields. Join-table links are removed with either side.

## On MongoDB, or with `defineModel`

`defineModel` keeps relations portable: a `ref` is a plain id field on both engines, with no foreign key, and `populate` resolves it in a batched second query:

```ts
await Post.find({ published: true }, { populate: 'author' });
```

There is no `include`, relation filtering or nested writes there. For those, use `defineTable` on PostgreSQL. See [Which model API?](./which-api.md).
