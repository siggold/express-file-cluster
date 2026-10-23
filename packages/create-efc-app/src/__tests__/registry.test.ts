import { describe, it, expect } from 'vitest';
import { ITEMS, VARIANTS, renderVariant, withDependencies } from '../registry.js';

// `efc add` itself (planning, applying, converging with create-time output) is tested in
// core: packages/core/src/__tests__/cli/registry.test.ts.
describe('registry rendering', () => {
  it('resolves dependencies first', () => {
    expect(withDependencies(['admin-users'])).toEqual(['auth', 'admin', 'admin-users']);
    expect(withDependencies(['mailer', 'auth', 'billing'])).toEqual([
      'email-client',
      'auth',
      'billing',
    ]);
  });

  for (const v of VARIANTS) {
    // renderVariant throws if an item changes another's files, or renders differently once
    // other items are installed, or if a generated file belongs to no item.
    it(`every item is self-contained (${v.key})`, async () => {
      const { items, base } = await renderVariant(v);
      expect(items.map((i) => i.name)).toEqual(ITEMS.map((i) => i.name));
      expect(base.map((f) => f.path)).toContain(
        `src/api/health.${v.language === 'typescript' ? 'ts' : 'js'}`,
      );
      for (const item of items) expect(item.files.length, item.name).toBeGreaterThan(0);
    }, 60_000);
  }
});
