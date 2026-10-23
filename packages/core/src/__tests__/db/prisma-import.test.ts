import { describe, it, expect } from 'vitest';
import { importPrisma } from '../../db/prisma-import.js';
import { modelFile } from '../../db/codegen.js';

const model = (src: string, name: string) => {
  const m = importPrisma(src).models.find((x) => x.name === name)!;
  return { ...m, fields: Object.fromEntries(m.fields) };
};

describe('import-prisma', () => {
  it('maps scalars, ids, timestamps, defaults, @map and indexes', () => {
    const src = `
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }
      enum Status {
        DRAFT @map("draft")
        LIVE  @map("live")
      }
      model Order {
        id        BigInt   @id @default(autoincrement())
        number    Int      @default(autoincrement())
        code      String   @db.VarChar(12) @map("order_code")
        total     Decimal  @db.Decimal(12, 2)
        status    Status   @default(DRAFT)
        ref       String   @default(uuid()) @db.Uuid
        createdAt DateTime @default(now())
        @@unique([code, status], map: "orders_code_status")
        @@map("orders")
      }`;
    const m = model(src, 'Order');
    expect(m.options).toEqual({
      id: 'bigserial',
      timestamps: { updatedAt: false },
      indexes: [{ fields: { code: 1, status: 1 }, unique: true, name: 'orders_code_status' }],
    });
    expect(m.fields).toEqual({
      number: { type: 'number', required: true, sequence: true },
      code: { type: 'string', maxLength: 12, required: true, column: 'order_code' },
      total: { type: 'decimal', precision: 12, scale: 2, required: true },
      status: {
        type: 'string',
        enum: ['draft', 'live'],
        nativeEnum: true,
        required: true,
        default: 'draft',
      },
      ref: { type: 'uuid', required: true, default: '$uuid' },
    });
  });

  it('folds foreign-key scalars into refs and adds back-relations, incl. self and m:n', () => {
    const src = `
      model User {
        id        String  @id @default(uuid())
        manager   User?   @relation("Reports", fields: [managerId], references: [id], onDelete: SetNull)
        managerId String?
        reports   User[]  @relation("Reports")
        followers User[]  @relation("Follows")
        following User[]  @relation("Follows")
        groups    Group[]
      }
      model Group {
        id      Int    @id @default(autoincrement())
        members User[]
      }`;
    const user = model(src, 'User');
    expect(user.fields['manager']).toEqual({
      type: 'uuid',
      ref: 'User',
      onDelete: 'setNull',
      column: 'managerId',
    });
    expect(user.fields['managerId']).toBeUndefined();
    // Self m:n: the alphabetically first side holds the array, the other is a relation.
    expect(user.fields['followers']).toEqual({ type: 'array', of: 'uuid', ref: 'User' });
    expect(user.options['relations']).toEqual({
      reports: { hasMany: 'User', foreignKey: 'manager' },
      following: { hasMany: 'User', foreignKey: 'followers' },
      groups: { hasMany: 'Group', foreignKey: 'members' },
    });
    // Group < User: Group owns the join table, typed like User's id.
    expect(model(src, 'Group').fields['members']).toEqual({
      type: 'array',
      of: 'uuid',
      ref: 'User',
    });
    expect(modelFile(importPrisma(src).models[1]!)).toContain(
      "members: { type: 'array', of: 'uuid', ref: 'User' },",
    );
  });

  it('refuses non-PostgreSQL schemas and notes what it cannot carry', () => {
    expect(() => importPrisma('datasource db {\n  provider = "mongodb"\n  url = "x"\n}')).toThrow(
      /provider is "mongodb"/,
    );
    const { models, warnings } = importPrisma(`
      model Pair {
        a Int
        b Int
        @@id([a, b])
      }
      model File {
        id   String @id @default(cuid())
        data Bytes
      }`);
    expect(warnings).toEqual(["Pair: composite @@id isn't supported — skipped"]);
    expect(models.map((m) => m.name)).toEqual(['File']);
    expect(models[0]!.notes.join('\n')).toMatch(
      /cuid\(\) ids become uuid[\s\S]*Bytes has no EFC type/,
    );
  });
});
