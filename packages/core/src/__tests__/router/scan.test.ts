import { describe, it, expect } from 'vitest';
import { filePathToUrlPath } from '../../router/scan.js';

describe('filePathToUrlPath', () => {
  it('maps static files to their path', () => {
    expect(filePathToUrlPath('/health.ts')).toBe('/health');
    expect(filePathToUrlPath('/users/profile.ts')).toBe('/users/profile');
  });

  it('maps index files to parent path', () => {
    expect(filePathToUrlPath('/index.ts')).toBe('/');
    expect(filePathToUrlPath('/users/index.ts')).toBe('/users');
  });

  it('maps dynamic segments', () => {
    expect(filePathToUrlPath('/users/[id].ts')).toBe('/users/:id');
    expect(filePathToUrlPath('/posts/[slug]/comments.ts')).toBe('/posts/:slug/comments');
  });

  it('handles nested dynamic', () => {
    expect(filePathToUrlPath('/a/[b]/c/[d].ts')).toBe('/a/:b/c/:d');
  });
});

describe('filePathToUrlPath — optional and catch-all segments', () => {
  it('maps [[id]] to an optional param', () => {
    expect(filePathToUrlPath('/users/[[id]].ts')).toBe('/users/:id?');
  });

  it('maps [...slug] and [[...slug]] to catch-alls', () => {
    expect(filePathToUrlPath('/docs/[...slug].ts')).toBe('/docs/:slug*');
    expect(filePathToUrlPath('/docs/[[...slug]].ts')).toBe('/docs/:slug*?');
  });
});

describe('scanDir — ordering and catch-all patterns', () => {
  it('orders static < dynamic < optional < catch-all < optional catch-all at each position', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { scanDir } = await import('../../router/scan.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-scan-'));
    for (const f of ['[[...all]].js', '[...rest].js', '[[opt]].js', '[id].js', 'about.js']) {
      fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'p', f), '');
    }
    try {
      expect(scanDir(dir).map((r) => r.urlPath)).toEqual([
        '/p/about',
        '/p/:id',
        '/p/:opt?',
        '/p/:rest*',
        '/p/:all*?',
      ]);
      const rest = scanDir(dir).find((r) => r.urlPath === '/p/:rest*')!;
      expect(rest.params).toEqual(['rest']);
      expect(rest.pattern?.test('/p/a/b/c')).toBe(true);
      expect(rest.pattern?.test('/p')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a catch-all that is not the last segment', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { scanDir } = await import('../../router/scan.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-scan-'));
    fs.mkdirSync(path.join(dir, '[...rest]'), { recursive: true });
    fs.writeFileSync(path.join(dir, '[...rest]', 'edit.js'), '');
    try {
      expect(() => scanDir(dir)).toThrow(/must be the last path segment/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
