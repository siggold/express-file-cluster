import { describe, it, expect } from 'vitest';
import { defineModel } from '../../db/model.js';
import mongoose from 'mongoose';

// Smoke test: exercises defineModel's mongoose schema compilation directly
// (enum, nested array sub-schemas, plain + function defaults) using document
// validation, which runs in-process — no live DB connection is required.

// doc.validate() rejects with a ValidationError instead of returning one, as the
// (deprecated in mongoose 9, removed in 10) validateSync() did.
const validationError = (doc: mongoose.Document) =>
  doc.validate().then(
    () => undefined,
    (err: mongoose.Error.ValidationError) => err,
  );

describe('defineModel — mongoose schema compilation', () => {
  it('builds enum, nested-array, and default fields correctly', async () => {
    // Without a live connection, mongoose buffers commands indefinitely by
    // default rather than failing fast — disable buffering so count() below
    // rejects immediately instead of hanging until bufferTimeoutMS.
    mongoose.set('bufferCommands', false);

    const Model = defineModel<{
      role: string;
      tags: string[];
      createdLabel: string;
      route_progress: { route_id: string; visited: boolean }[];
    }>('SmokeTestModel', {
      role: { type: 'string', enum: ['member', 'admin'], default: 'member' },
      tags: { type: 'array', of: 'string', default: [] },
      createdLabel: { type: 'string', default: () => 'computed-default' },
      route_progress: [
        {
          route_id: { type: 'string', required: true },
          visited: { type: 'boolean', required: true },
        },
      ],
    });

    // Trigger getModel()'s lazy schema build/registration. This will reject
    // (no live DB connection) — we only care that the mongoose Model gets
    // registered as a side effect.
    await Model.count().catch(() => {});

    const RawModel = mongoose.models['SmokeTestModel'];
    expect(RawModel).toBeDefined();

    // --- enum ---
    const badRole = new RawModel({ role: 'superadmin' });
    const badRoleErr = await validationError(badRole);
    expect(badRoleErr?.errors['role']).toBeDefined();

    const goodRole = new RawModel({ role: 'admin' });
    expect((await validationError(goodRole))?.errors['role']).toBeUndefined();

    // --- default (plain value) ---
    const defaultsDoc = new RawModel({});
    expect(defaultsDoc.get('role')).toBe('member');
    expect(defaultsDoc.get('tags')).toEqual([]);

    // --- default (function) ---
    expect(defaultsDoc.get('createdLabel')).toBe('computed-default');

    // --- nested array sub-schema: required field enforced ---
    const missingNested = new RawModel({
      role: 'member',
      route_progress: [{ visited: true }], // route_id missing
    });
    const nestedErr = await validationError(missingNested);
    expect(nestedErr?.errors['route_progress.0.route_id']).toBeDefined();

    const validNested = new RawModel({
      role: 'member',
      route_progress: [{ route_id: 'r1', visited: true }],
    });
    expect(await validationError(validNested)).toBeUndefined();
  });

  it('resolves $now / $uuid default operator codes per-document', async () => {
    mongoose.set('bufferCommands', false);

    const Model = defineModel<{ createdAt: Date; token: string }>('SmokeOperatorDefaultsModel', {
      createdAt: { type: 'date', default: '$now' },
      token: { type: 'string', default: '$uuid' },
    });

    await Model.count().catch(() => {});
    const RawModel = mongoose.models['SmokeOperatorDefaultsModel'];

    const before = Date.now();
    const docA = new RawModel({});
    const docB = new RawModel({});
    const after = Date.now();

    // $now — resolves to an actual Date, generated at construction time
    const createdAt = docA.get('createdAt') as Date;
    expect(createdAt).toBeInstanceOf(Date);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(createdAt.getTime()).toBeLessThanOrEqual(after);

    // $uuid — a valid v4-shaped UUID, freshly generated per document (not baked in once)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(docA.get('token')).toMatch(uuidRegex);
    expect(docB.get('token')).toMatch(uuidRegex);
    expect(docA.get('token')).not.toBe(docB.get('token'));

    // A literal string default equal to a real word (not '$now'/'$uuid') is untouched
    const LiteralModel = defineModel<{ label: string }>('SmokeLiteralDefaultModel', {
      label: { type: 'string', default: 'plain-value' },
    });
    await LiteralModel.count().catch(() => {});
    const RawLiteral = mongoose.models['SmokeLiteralDefaultModel'];
    expect(new RawLiteral({}).get('label')).toBe('plain-value');
  });

  it('resolves $objectId / $timestamp / $shortId default operator codes per-document', async () => {
    mongoose.set('bufferCommands', false);

    const Model = defineModel<{ ownerId: string; createdAtMs: number; apiKey: string }>(
      'SmokeMoreOperatorDefaultsModel',
      {
        ownerId: { type: 'objectId', default: '$objectId' },
        createdAtMs: { type: 'number', default: '$timestamp' },
        apiKey: { type: 'string', default: '$shortId' },
      },
    );

    await Model.count().catch(() => {});
    const RawModel = mongoose.models['SmokeMoreOperatorDefaultsModel'];

    const before = Date.now();
    const docA = new RawModel({});
    const docB = new RawModel({});
    const after = Date.now();

    // $objectId — a fresh, valid ObjectId per document
    expect(mongoose.isValidObjectId(docA.get('ownerId'))).toBe(true);
    expect(String(docA.get('ownerId'))).not.toBe(String(docB.get('ownerId')));

    // $timestamp — epoch millis as a plain number
    const createdAtMs = docA.get('createdAtMs') as number;
    expect(typeof createdAtMs).toBe('number');
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);

    // $shortId — random base64url string, freshly generated per document
    expect(docA.get('apiKey')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(docA.get('apiKey')).not.toBe(docB.get('apiKey'));
  });

  it('respects the ModelOptions timestamps argument', async () => {
    mongoose.set('bufferCommands', false);

    const WithTimestamps = defineModel<{ name: string }>('SmokeTimestampsOnModel', {
      name: { type: 'string' },
    });
    await WithTimestamps.count().catch(() => {});
    const rawWithTimestamps = mongoose.models['SmokeTimestampsOnModel'];
    expect(rawWithTimestamps.schema.path('createdAt')).toBeDefined();
    expect(rawWithTimestamps.schema.path('updatedAt')).toBeDefined();

    const WithoutTimestamps = defineModel<{ name: string }>(
      'SmokeTimestampsOffModel',
      { name: { type: 'string' } },
      { timestamps: false },
    );
    await WithoutTimestamps.count().catch(() => {});
    const rawWithoutTimestamps = mongoose.models['SmokeTimestampsOffModel'];
    expect(rawWithoutTimestamps.schema.path('createdAt')).toBeUndefined();
    expect(rawWithoutTimestamps.schema.path('updatedAt')).toBeUndefined();

    const CustomTimestamps = defineModel<{ name: string }>(
      'SmokeTimestampsCustomModel',
      { name: { type: 'string' } },
      { timestamps: { createdAt: 'created_at', updatedAt: false } },
    );
    await CustomTimestamps.count().catch(() => {});
    const rawCustomTimestamps = mongoose.models['SmokeTimestampsCustomModel'];
    expect(rawCustomTimestamps.schema.path('created_at')).toBeDefined();
    expect(rawCustomTimestamps.schema.path('createdAt')).toBeUndefined();
    expect(rawCustomTimestamps.schema.path('updatedAt')).toBeUndefined();
  });
});
