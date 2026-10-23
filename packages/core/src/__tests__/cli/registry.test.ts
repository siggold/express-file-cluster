import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  Registry,
  applyAdd,
  envFromAnswers,
  normalizeAnswer,
  planAdd,
  promptApplies,
  promptDefault,
  readEfcJson,
  itemStatus,
} from '../../cli/registry.js';
// The items come from create-efc-app's templates — rendered here, the way
// scripts/bundle-registry.mjs renders them into dist/registry at build time.
import { scaffold } from '../../../../create-efc-app/src/scaffold.js';
import {
  ITEMS,
  VARIANTS,
  isManagedPath,
  parseEnv,
  registryOptions,
  renderVariant,
  withDependencies,
  writeManifest,
  type Variant,
} from '../../../../create-efc-app/src/registry.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function writeRegistry(dir: string): Promise<void> {
  let index;
  for (const v of VARIANTS) {
    const r = await renderVariant(v);
    index ??= r.index;
    await fs.outputJson(path.join(dir, v.key, '_base.json'), { files: r.base });
    for (const item of r.items)
      await fs.outputJson(path.join(dir, v.key, `${item.name}.json`), item);
  }
  await fs.outputJson(path.join(dir, 'index.json'), {
    version: '0.0.0-test',
    variants: VARIANTS,
    items: index,
  });
}

async function createApp(v: Variant, items: string[], name: string): Promise<string> {
  const parent = tmp('efc-app-');
  const dest = path.join(parent, name);
  await scaffold(registryOptions(v, items, { projectName: dest }));
  await writeManifest(dest, registryOptions(v, items), items);
  return dest;
}

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.set(path.relative(dir, abs).split(path.sep).join('/'), fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

let registry: Registry;
beforeAll(async () => {
  const dir = tmp('efc-registry-test-');
  await writeRegistry(dir);
  registry = new Registry(dir);
}, 120_000);

describe('registry items', () => {
  it('cover every feature and resolve dependencies first', () => {
    expect(withDependencies(['admin-users'])).toEqual(['auth', 'admin', 'admin-users']);
    expect(registry.index.items.map((i) => i.name)).toEqual(ITEMS.map((i) => i.name));
    const meta = (n: string) => registry.index.items.find((i) => i.name === n)!;
    expect(meta('auth').requiresTasks).toBe(true);
    expect(meta('user-profile').requiresTasks).toBe(false);
  });

  it('carry their npm packages and env vars', () => {
    const auth = registry.item('ts-pg-table', 'auth');
    expect(auth.dependencies).toEqual({ bcrypt: '^5.1.0' });
    expect(auth.devDependencies).toEqual({ '@types/bcrypt': '^5.0.0' });
    const mailer = registry.item('js-mongo', 'mailer');
    expect(mailer.dependencies).toEqual({ nodemailer: '^6.9.0' });
    expect(mailer.devDependencies).toEqual({});
    expect(mailer.env.map((e) => e.key)).toEqual([
      'APP_URL',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
    ]);
    expect(mailer.files.map((f) => f.path)).toEqual(['src/tasks/SendEmail.js']);
  });
});

describe('efc add', () => {
  for (const [i, v] of VARIANTS.entries()) {
    it(`base + every item in any order = created with every item (${v.key})`, async () => {
      const all = ITEMS.map((x) => x.name);
      const base = await createApp(v, [], 'base-app');
      const full = await createApp(v, all, 'full-app');

      // Add items in a scrambled order, a few at a time, the way an app grows.
      const order = shuffle(all, i + 7);
      for (let k = 0; k < order.length; k += 3) {
        const plan = planAdd(base, registry, order.slice(k, k + 3));
        expect(plan.problems).toEqual([]);
        expect(plan.files.filter((f) => f.action === 'conflict')).toEqual([]);
        const result = applyAdd(base, plan, registry);
        expect(result.manual).toEqual([]);
      }

      const grown = tree(base);
      const created = tree(full);
      for (const [p, content] of created) {
        if (isManagedPath(p) || p === 'efc.json') continue;
        expect(grown.get(p), p).toBe(content);
      }
      for (const p of grown.keys()) {
        if (!isManagedPath(p) && p !== 'efc.json') expect(created.has(p), p).toBe(true);
      }

      const pkg = (t: Map<string, string>) => JSON.parse(t.get('package.json')!);
      expect(pkg(grown).dependencies).toEqual(pkg(created).dependencies);
      expect(pkg(grown).devDependencies ?? {}).toEqual(pkg(created).devDependencies ?? {});
      expect([...parseEnv(grown.get('.env')).keys()].sort()).toEqual(
        [...parseEnv(created.get('.env')).keys()].sort(),
      );
      expect([...parseEnv(grown.get('.env.example')).keys()].sort()).toEqual(
        [...parseEnv(created.get('.env.example')).keys()].sort(),
      );

      // The model index lists the same models (defineTable apps).
      const idx = `src/model/index.${v.language === 'typescript' ? 'ts' : 'js'}`;
      const lines = (s: string | undefined) =>
        (s ?? '')
          .split('\n')
          .filter((l) => /^\s*(export|import type|\w+: typeof)/.test(l))
          .sort();
      expect(lines(grown.get(idx))).toEqual(lines(created.get(idx)));

      const manifest = readEfcJson(base)!;
      expect(manifest.items).toEqual([...all].sort());
      for (const n of all) {
        expect(itemStatus(base, registry, manifest, n).every((f) => f.status === 'unchanged')).toBe(
          true,
        );
      }
    }, 60_000);
  }

  it('updates untouched files, leaves changed ones alone, and re-adding is a no-op', async () => {
    const v = VARIANTS.find((x) => x.key === 'ts-pg-table')!;
    const app = await createApp(v, [], 'app');
    const sendEmail = path.join(app, 'src/tasks/SendEmail.ts');
    const stub = fs.readFileSync(sendEmail, 'utf8');

    // The mailer replaces the base SendEmail stub, which efc wrote and nobody changed.
    let plan = planAdd(app, registry, ['mailer']);
    expect(plan.files.map((f) => [f.path, f.action])).toEqual([
      ['src/tasks/SendEmail.ts', 'update'],
    ]);
    applyAdd(app, plan, registry);
    expect(fs.readFileSync(sendEmail, 'utf8')).toContain('nodemailer');
    expect(fs.readFileSync(path.join(app, '.env'), 'utf8')).toContain('SMTP_HOST=');
    expect(
      JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).dependencies.nodemailer,
    ).toBe('^6.9.0');

    // Already installed → nothing to do unless named again; named again → all identical.
    expect(planAdd(app, registry, ['auth', 'mailer']).items).toEqual(['auth', 'email-client']);
    plan = planAdd(app, registry, ['mailer']);
    expect(plan.files.every((f) => f.action === 'skip-identical')).toBe(true);
    expect(plan.env).toEqual([]);

    // A file the app changed is a conflict; --overwrite replaces it.
    applyAdd(app, planAdd(app, registry, ['auth']), registry);
    const login = path.join(app, 'src/api/auth/login.ts');
    fs.appendFileSync(login, '\n// customised\n');
    const status = itemStatus(app, registry, readEfcJson(app)!, 'auth');
    expect(status.find((f) => f.path === 'src/api/auth/login.ts')!.status).toBe('modified');
    plan = planAdd(app, registry, ['auth']);
    expect(plan.files.find((f) => f.path === 'src/api/auth/login.ts')!.action).toBe('conflict');
    applyAdd(app, plan, registry);
    expect(fs.readFileSync(login, 'utf8')).toContain('// customised');
    plan = planAdd(app, registry, ['auth'], { overwrite: true });
    expect(plan.files.find((f) => f.path === 'src/api/auth/login.ts')!.action).toBe('overwrite');
    applyAdd(app, plan, registry);
    expect(fs.readFileSync(login, 'utf8')).not.toContain('// customised');
    expect(stub).toContain('TODO');
  });

  it('works on apps without efc.json (detects the variant) and brings the SendEmail stub along', async () => {
    const v = VARIANTS.find((x) => x.key === 'js-mongo')!;
    const app = await createApp(v, [], 'legacy');
    fs.removeSync(path.join(app, 'efc.json'));
    fs.removeSync(path.join(app, 'src/tasks/SendEmail.js'));
    const plan = planAdd(app, registry, ['forgot-password']);
    expect(plan.variant).toBe('js-mongo');
    expect(plan.items).toEqual(['auth', 'forgot-password']);
    expect(plan.files.map((f) => f.path)).toContain('src/tasks/SendEmail.js');
    applyAdd(app, plan, registry);
    expect(readEfcJson(app)!.items).toEqual(['auth', 'forgot-password']);
  });

  it('refuses email-sending items without a task backend', async () => {
    const v = VARIANTS.find((x) => x.key === 'ts-mongo')!;
    const app = await createApp(v, [], 'no-tasks');
    const cfg = { ...readEfcJson(app)!, tasks: null };
    expect(planAdd(app, registry, ['auth'], {}, cfg).problems[0]).toMatch(/task backend/);
    expect(planAdd(app, registry, ['user-profile'], {}, cfg).problems[0]).toMatch(/task backend/);
  });
});

describe('item prompts', () => {
  it('email-client asks for SMTP, and Gmail fills in host and port', async () => {
    const v = VARIANTS.find((x) => x.key === 'ts-mongo')!;
    const app = await createApp(v, [], 'mail');
    const plan = planAdd(app, registry, ['email-client']);
    const names = plan.prompts.map((p) => p.name);
    expect(names).toEqual([
      'provider',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_PASS',
      'SMTP_FROM',
      'APP_URL',
    ]);

    // Gmail: no host/port questions; the app password must be 16 characters.
    const answers: Record<string, string> = { provider: 'gmail' };
    const asked = plan.prompts.filter((p) => promptApplies(p, answers) && p.name !== 'provider');
    expect(asked.map((p) => p.name)).toEqual(['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']);
    const pass = asked.find((p) => p.name === 'SMTP_PASS')!;
    expect(normalizeAnswer(pass, 'hunter2', app)).toHaveProperty('error');
    expect(normalizeAnswer(pass, 'abcd efgh ijkl mnop', app)).toEqual({
      value: 'abcdefghijklmnop',
    });
    answers['SMTP_USER'] = 'me@gmail.com';
    answers['SMTP_PASS'] = 'abcdefghijklmnop';
    expect(promptDefault(asked.find((p) => p.name === 'SMTP_FROM')!, answers)).toBe('me@gmail.com');
    answers['SMTP_FROM'] = 'me@gmail.com';
    answers['APP_URL'] = 'https://my.app';

    const env = envFromAnswers(plan.prompts, answers);
    expect(env).toEqual({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'me@gmail.com',
      SMTP_PASS: 'abcdefghijklmnop',
      SMTP_FROM: 'me@gmail.com',
      APP_URL: 'https://my.app',
    });
    applyAdd(app, plan, registry, env);
    const dotenv = fs.readFileSync(path.join(app, '.env'), 'utf8');
    expect(dotenv).toContain('SMTP_HOST=smtp.gmail.com\n');
    expect(dotenv).toContain('SMTP_PASS=abcdefghijklmnop\n');
    // .env.example keeps placeholders, never the real values.
    expect(fs.readFileSync(path.join(app, '.env.example'), 'utf8')).not.toContain(
      'abcdefghijklmnop',
    );

    // Already configured → nothing to ask on a re-add.
    expect(planAdd(app, registry, ['email-client']).prompts).toEqual([]);
  });

  it('auth@google and auth@apple ask for their credentials; the Apple key is read from its file', async () => {
    const v = VARIANTS.find((x) => x.key === 'js-pg-table')!;
    const app = await createApp(v, [], 'oauth');
    const plan = planAdd(app, registry, ['auth@google', 'auth@apple']);
    expect(plan.items).toEqual(['auth', 'auth@google', 'auth@apple']);
    expect(plan.dependencies).toMatchObject({
      jose: expect.any(String),
      bcrypt: expect.any(String),
    });
    expect(plan.prompts.map((p) => p.name)).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REDIRECT_URI',
      'OAUTH_SUCCESS_REDIRECT',
      'APPLE_CLIENT_ID',
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID',
      'APPLE_PRIVATE_KEY',
      'APPLE_REDIRECT_URI',
    ]);
    const files = plan.files.map((f) => f.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'src/api/auth/google/index.js',
        'src/api/auth/google/callback.js',
        'src/api/auth/apple/index.js',
        'src/api/auth/apple/callback.js',
        'src/lib/oauth.js',
        'src/model/OAuthAccount.js',
      ]),
    );

    const p = (n: string) => plan.prompts.find((x) => x.name === n)!;
    expect(normalizeAnswer(p('GOOGLE_CLIENT_ID'), 'nope', app)).toHaveProperty('error');
    expect(
      normalizeAnswer(p('APPLE_REDIRECT_URI'), 'http://localhost:3000/cb', app),
    ).toHaveProperty('error');
    fs.writeFileSync(
      path.join(app, 'AuthKey.p8'),
      '-----BEGIN PRIVATE KEY-----\nMIGT\nAgEA\n-----END PRIVATE KEY-----\n',
    );
    const key = normalizeAnswer(p('APPLE_PRIVATE_KEY'), './AuthKey.p8', app);
    expect(key).toEqual({
      value: '-----BEGIN PRIVATE KEY-----\\nMIGT\\nAgEA\\n-----END PRIVATE KEY-----',
    });
    expect(normalizeAnswer(p('APPLE_PRIVATE_KEY'), './missing.p8', app)).toHaveProperty('error');

    applyAdd(app, plan, registry, {
      GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'has space#and hash',
      APPLE_PRIVATE_KEY: (key as { value: string }).value,
    });
    const dotenv = fs.readFileSync(path.join(app, '.env'), 'utf8');
    expect(dotenv).toContain('GOOGLE_CLIENT_ID=x.apps.googleusercontent.com\n');
    expect(dotenv).toContain("GOOGLE_CLIENT_SECRET='has space#and hash'\n");
    expect(dotenv).toContain("APPLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\\nMIGT");
    // Unanswered vars keep their defaults.
    expect(dotenv).toContain(
      'GOOGLE_REDIRECT_URI=http://localhost:3000/v1/api/auth/google/callback\n',
    );
    // OAuth accounts are registered in the model index (defineTable).
    expect(fs.readFileSync(path.join(app, 'src/model/index.js'), 'utf8')).toContain(
      "export { OAuthAccount } from './OAuthAccount.js';",
    );
  });
});
