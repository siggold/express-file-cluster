import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { execFileSync } from 'node:child_process';
import { scaffold, NO_ADMIN_FEATURES, NO_USER_FEATURES } from '../scaffold.js';
import type { ScaffoldOptions } from '../scaffold.js';

// Regression test for a real bug found by actually running a fresh scaffold:
// `writeEntryPoint()` used to hardcode `cluster: ${opts.cluster}` into the generated
// src/index.ts. Selecting "Multi-core clustering" (the default) emitted a literal
// `cluster: true`, which always wins over ignite()'s own NODE_ENV-aware default — so
// `efc start dev` clustered too, contradicting the documented single-process dev
// guarantee. Fixed: omit `cluster` entirely when it's wanted; only emit an explicit
// `cluster: false` when opted out.

const dirs: string[] = [];

function tmpDest(name: string): string {
  const dir = path.join(os.tmpdir(), `efc-scaffold-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}

function baseOptions(dest: string, cluster: boolean): ScaffoldOptions {
  return {
    projectName: dest,
    language: 'typescript',
    database: 'mongodb',
    authStrategy: 'http-only',
    cluster,
    tasks: true,
    taskBackend: 'bullmq',
    routeDocs: true,
    userPortal: false,
    adminPortal: false,
    userFeatures: NO_USER_FEATURES,
    adminFeatures: NO_ADMIN_FEATURES,
    rbac: false,
    mailer: false,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

describe('scaffold() — generated entrypoint cluster behavior', () => {
  it('omits `cluster` entirely when clustering is wanted, so ignite() dev/prod default applies', async () => {
    const dest = tmpDest('cluster-true');
    await scaffold(baseOptions(dest, true));
    const content = await fs.readFile(path.join(dest, 'src', 'index.ts'), 'utf8');

    expect(content).not.toMatch(/cluster:\s*true/);
    expect(content).not.toContain('cluster:');
  });

  it('emits an explicit `cluster: false` when clustering is opted out', async () => {
    const dest = tmpDest('cluster-false');
    await scaffold(baseOptions(dest, false));
    const content = await fs.readFile(path.join(dest, 'src', 'index.ts'), 'utf8');

    expect(content).toMatch(/cluster:\s*false/);
  });
});

describe('scaffold() — JavaScript projects', () => {
  // JS output was once untested and shipped TypeScript syntax in efc.config.js. Parse
  // every generated file with node --check, with every feature switched on.
  it('generates only syntactically valid JavaScript', async () => {
    const dest = tmpDest('js-syntax');
    const every = <T extends object>(flags: T): T =>
      Object.fromEntries(Object.keys(flags).map((k) => [k, true])) as T;
    await scaffold({
      ...baseOptions(dest, true),
      language: 'javascript',
      database: 'postgresql',
      taskBackend: 'pg-boss',
      userPortal: true,
      adminPortal: true,
      rbac: true,
      userFeatures: every(NO_USER_FEATURES),
      adminFeatures: every(NO_ADMIN_FEATURES),
    });

    const files: string[] = [path.join(dest, 'efc.config.js')];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(path.join(dest, 'src'));

    expect(files.filter((f) => f.endsWith('.ts'))).toEqual([]);
    const broken = files.filter((f) => {
      try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    });
    expect(broken.map((f) => path.relative(dest, f))).toEqual([]);
    expect(files.length).toBeGreaterThan(50);
  }, 60_000);
});

