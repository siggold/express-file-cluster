import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { defineModel } from '../../db/model.js';
import { runWithContext } from '../../context.js';

// These exercise behavior that genuinely needs a live MongoDB round trip
// (sequence/$increment counters, and the full validate+save pipeline) rather
// than schema-only compilation — unlike model.smoke.test.ts, which never
// connects. Skips itself, rather than failing CI, when no MongoDB is reachable
// (e.g. no local `mongod` and no CI service container wired up yet).
const MONGO_URL = process.env['EFC_TEST_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/efc_core_test';

let mongoAvailable = false;
try {
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

describe.skipIf(!mongoAvailable)('defineModel — live MongoDB integration', () => {
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('sequence: assigns a unique, incrementing value per document, before required validation', async () => {
    const Order = defineModel<{ orderNumber: number; label: string }>('IntegrationOrder', {
      orderNumber: { type: 'number', sequence: true, required: true },
      label: { type: 'string' },
    });

    const a = await Order.create({ label: 'first' });
    const b = await Order.create({ label: 'second' });
    const c = await Order.create({ label: 'third' });

    expect([a.orderNumber, b.orderNumber, c.orderNumber]).toEqual(
      [...[a, b, c].map((d) => d.orderNumber)].sort((x, y) => x - y),
    );
    expect(new Set([a.orderNumber, b.orderNumber, c.orderNumber]).size).toBe(3);
    expect(b.orderNumber).toBe(a.orderNumber + 1);
    expect(c.orderNumber).toBe(b.orderNumber + 1);
  });

  it('sequence: an explicit string key shares one counter across models', async () => {
    const Invoice = defineModel<{ num: number }>('IntegrationInvoice', {
      num: { type: 'number', sequence: 'shared-doc-number' },
    });
    const Receipt = defineModel<{ num: number }>('IntegrationReceipt', {
      num: { type: 'number', sequence: 'shared-doc-number' },
    });

    const inv = await Invoice.create({});
    const rec = await Receipt.create({});
    const inv2 = await Invoice.create({});

    expect(rec.num).toBe(inv.num + 1);
    expect(inv2.num).toBe(rec.num + 1);
  });

  it('sequence: does not overwrite an explicitly provided value', async () => {
    const Ticket = defineModel<{ num: number }>('IntegrationTicket', {
      num: { type: 'number', sequence: true },
    });
    const explicit = await Ticket.create({ num: 999 });
    expect(explicit.num).toBe(999);
  });

  it('update() returns the post-update document (returnDocument: "after")', async () => {
    const Widget = defineModel<{ name: string; count: number }>('IntegrationWidget', {
      name: { type: 'string', required: true },
      count: { type: 'number', default: 0 },
    });

    const created = await Widget.create({ name: 'gadget' });
    const updated = await Widget.update(created.id, { count: 5 });

    expect(updated).not.toBeNull();
    expect(updated?.count).toBe(5);
    expect(updated?.name).toBe('gadget');
  });

  it('$currentUser: resolves a plucked field from the request context per-document', async () => {
    const Post = defineModel<{ title: string; createdBy: string }>('IntegrationPost', {
      title: { type: 'string', required: true },
      createdBy: { type: 'string', default: '$currentUser.id' },
    });

    const doc = await runWithContext({ user: { id: 'user-42', role: 'admin' } }, () =>
      Post.create({ title: 'hello' }),
    );

    expect(doc.createdBy).toBe('user-42');
  });

  it('$currentUser: bare code resolves the whole payload object', async () => {
    const Audit = defineModel<{ action: string; actor: Record<string, unknown> }>(
      'IntegrationAudit',
      {
        action: { type: 'string', required: true },
        actor: { type: 'object', default: '$currentUser' },
      },
    );

    const doc = await runWithContext({ user: { id: 'user-7', role: 'member' } }, () =>
      Audit.create({ action: 'login' }),
    );

    expect(doc.actor).toEqual({ id: 'user-7', role: 'member' });
  });

  it('$currentUser: resolves to undefined outside any request context', async () => {
    const Comment = defineModel<{ body: string; createdBy?: string }>('IntegrationComment', {
      body: { type: 'string', required: true },
      createdBy: { type: 'string', default: '$currentUser.id' },
    });

    const doc = await Comment.create({ body: 'no context here' });
    expect(doc.createdBy).toBeUndefined();
  });
});
