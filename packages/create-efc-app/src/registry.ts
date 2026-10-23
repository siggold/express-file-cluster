import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { scaffold, NO_ADMIN_FEATURES, NO_USER_FEATURES, type ScaffoldOptions } from './scaffold.js';

// The feature registry behind `efc add` (shadcn-style): the base app is the server, src/api,
// src/tasks and the database; every feature is a registry item whose files are copied into
// the app and owned by it from then on. Items are rendered from the same templates
// `create-efc-app` uses, once per variant, by scaffolding in registry mode with and without
// the item and taking the difference — see `renderVariant`.

export interface Variant {
  key: string;
  language: ScaffoldOptions['language'];
  database: ScaffoldOptions['database'];
  modelApi: 'defineModel' | 'defineTable';
}

export const VARIANTS: Variant[] = (['typescript', 'javascript'] as const).flatMap((language) => {
  const lang = language === 'typescript' ? 'ts' : 'js';
  return [
    {
      key: `${lang}-mongo`,
      language,
      database: 'mongodb' as const,
      modelApi: 'defineModel' as const,
    },
    {
      key: `${lang}-pg-model`,
      language,
      database: 'postgresql' as const,
      modelApi: 'defineModel' as const,
    },
    {
      key: `${lang}-pg-table`,
      language,
      database: 'postgresql' as const,
      modelApi: 'defineTable' as const,
    },
  ];
});

export function variantKey(v: Pick<Variant, 'language' | 'database' | 'modelApi'>): string {
  const found = VARIANTS.find(
    (x) =>
      x.language === v.language &&
      x.database === v.database &&
      (x.database === 'mongodb' || x.modelApi === v.modelApi),
  );
  if (!found) throw new Error(`No registry variant for ${JSON.stringify(v)}`);
  return found.key;
}

export type ItemGroup = 'auth' | 'user' | 'admin' | 'integrations';

/**
 * A question `efc add` / `create-efc-app` asks when an item is added. Answers named like an
 * env var (UPPER_CASE) are written to .env; lower-case names are choices that only steer
 * later questions (`when`) or set env vars through the chosen option's `env`.
 */
export interface ItemPrompt {
  name: string;
  message: string;
  type: 'text' | 'password' | 'select' | 'file';
  options?: { value: string; label: string; hint?: string; env?: Record<string, string> }[];
  /** Default answer; `{{NAME}}` is replaced with an earlier answer. */
  default?: string;
  placeholder?: string;
  /** Only ask when earlier answers match. */
  when?: Record<string, string>;
  required?: boolean;
  /** The answer (after `stripSpaces`) must match this regex. */
  pattern?: string;
  patternMessage?: string;
  stripSpaces?: boolean;
  /** Shown before the question. */
  note?: string;
}

export interface ItemDef {
  name: string;
  /** Other names `efc add` accepts for this item. */
  aliases?: string[];
  /** Questions asked when the item is added (written to .env). */
  prompts?: ItemPrompt[];
  title: string;
  description: string;
  group: ItemGroup;
  /** Other items this one needs (installed first). */
  registryDependencies: string[];
  /** Base files this item replaces (e.g. the mailer's real SendEmail task). */
  replaces?: string[];
  /** Printed after `efc add`. */
  docs?: string;
  enable(o: ScaffoldOptions): void;
}

const user =
  (flag: keyof ScaffoldOptions['userFeatures']) =>
  (o: ScaffoldOptions): void => {
    o.userPortal = true;
    o.userFeatures = { ...o.userFeatures, [flag]: true };
  };
const admin =
  (flag: keyof ScaffoldOptions['adminFeatures']) =>
  (o: ScaffoldOptions): void => {
    o.adminPortal = true;
    o.adminFeatures = { ...o.adminFeatures, [flag]: true };
  };

export const ITEMS: ItemDef[] = [
  {
    name: 'auth',
    title: 'Authentication',
    description: 'User & Admin models; register, login, logout and me routes',
    group: 'auth',
    registryDependencies: [],
    docs: "Tokens are issued per `authStrategy` in efc.config — 'http-only' (cookie) or 'localStorage' (Bearer). Verification emails go through the SendEmail task; `efc add email-client` makes it send real mail.",
    enable: (o) => {
      o.userPortal = true;
    },
  },
  {
    name: 'user-profile',
    title: 'Profile',
    description: 'GET/PUT /user/profile',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('profileViewing'),
  },
  {
    name: 'forgot-password',
    title: 'Forgot / reset password',
    description: 'forgot-password and reset-password routes',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('forgotPassword'),
  },
  {
    name: 'account-security',
    title: 'Account security',
    description: 'change password, 2FA, sessions, token refresh',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('accountSecurity'),
  },
  {
    name: 'email-verification',
    title: 'Email verification',
    description: 'verify-email and resend-verification routes',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('emailVerification'),
  },
  {
    name: 'account-settings',
    title: 'Account settings',
    description: 'avatar, settings, account, dashboard, activity',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('accountSettings'),
  },
  {
    name: 'notifications',
    title: 'Notifications',
    description: 'Notification model + /user/notifications',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('notifications'),
  },
  {
    name: 'files',
    title: 'Files, favorites & bookmarks',
    description: 'File model + files, favorites, bookmarks, search',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('filesAndMedia'),
  },
  {
    name: 'billing',
    title: 'API keys & billing',
    description: 'Plan, Subscription, Invoice, ApiKey models + user billing routes',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('apiAndBilling'),
  },
  {
    name: 'support',
    title: 'Support tickets',
    description: 'SupportTicket model + create & view own tickets',
    group: 'user',
    registryDependencies: ['auth'],
    enable: user('support'),
  },
  {
    name: 'admin',
    title: 'Admin portal',
    description: "admin dashboard stats, behind requireAuth('admin')",
    group: 'admin',
    registryDependencies: ['auth'],
    enable: (o) => {
      o.adminPortal = true;
    },
  },
  {
    name: 'admin-users',
    title: 'User management',
    description: 'list/create/suspend/verify/export users + stats',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('userManagement'),
  },
  {
    name: 'admin-admins',
    title: 'Admin & role management',
    description: 'manage other admins + Role model',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('adminManagement'),
  },
  {
    name: 'admin-analytics',
    title: 'Analytics',
    description: 'users, revenue, traffic dashboards',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('analytics'),
  },
  {
    name: 'admin-content',
    title: 'Content management',
    description: 'FAQ, Blog, Category models + admin routes',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('contentManagement'),
  },
  {
    name: 'admin-billing',
    title: 'Billing management',
    description: 'Plan, Coupon models + plans, coupons, subscriptions',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('billingManagement'),
  },
  {
    name: 'admin-support',
    title: 'Support desk',
    description: 'view & respond to support tickets',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('supportManagement'),
  },
  {
    name: 'admin-logs',
    title: 'Notifications & audit logs',
    description: 'broadcast + audit/activity/security logs',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('notificationsAndLogs'),
  },
  {
    name: 'admin-system',
    title: 'System settings & health',
    description: 'app settings, health check, cache',
    group: 'admin',
    registryDependencies: ['admin'],
    enable: admin('systemSettings'),
  },
  {
    name: 'auth@google',
    title: 'Sign in with Google',
    description: 'GET /auth/google → Google → /auth/google/callback (OpenID Connect + PKCE)',
    group: 'auth',
    registryDependencies: ['auth'],
    docs: 'Create an OAuth client (type "Web application") at console.cloud.google.com → APIs & Services → Credentials, and add GOOGLE_REDIRECT_URI as an authorised redirect URI. Send users to GET /v1/api/auth/google to sign in.',
    prompts: [
      {
        name: 'GOOGLE_CLIENT_ID',
        type: 'text',
        message: 'Google OAuth client ID:',
        placeholder: '1234-abc.apps.googleusercontent.com',
        required: true,
        pattern: '\\.apps\\.googleusercontent\\.com$',
        patternMessage: 'Google client IDs end in .apps.googleusercontent.com',
        note: 'console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID (Web application).',
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        type: 'password',
        message: 'Google OAuth client secret:',
        required: true,
      },
      {
        name: 'GOOGLE_REDIRECT_URI',
        type: 'text',
        message: 'Redirect URI (register it on the client):',
        default: 'http://localhost:3000/v1/api/auth/google/callback',
      },
      {
        name: 'OAUTH_SUCCESS_REDIRECT',
        type: 'text',
        message: 'Where to send the browser after sign-in:',
        default: 'http://localhost:3000/',
      },
    ],
    enable: (o) => {
      o.userPortal = true;
      o.oauth = { ...o.oauth, google: true };
    },
  },
  {
    name: 'auth@apple',
    title: 'Sign in with Apple',
    description: 'GET /auth/apple → Apple → POST /auth/apple/callback (form_post)',
    group: 'auth',
    registryDependencies: ['auth'],
    docs: 'Needs a Services ID with Sign in with Apple enabled, its return URL set to APPLE_REDIRECT_URI (https, on a verified domain — Apple rejects localhost), and a Sign in with Apple key (.p8). Send users to GET /v1/api/auth/apple to sign in.',
    prompts: [
      {
        name: 'APPLE_CLIENT_ID',
        type: 'text',
        message: 'Services ID (client ID):',
        placeholder: 'com.yourapp.signin',
        required: true,
        note: 'developer.apple.com → Certificates, IDs & Profiles: a Services ID with Sign in with Apple, and a key with Sign in with Apple (.p8).',
      },
      {
        name: 'APPLE_TEAM_ID',
        type: 'text',
        message: 'Team ID:',
        required: true,
        pattern: '^[A-Z0-9]{10}$',
        patternMessage: 'Team IDs are 10 characters (A-Z, 0-9)',
      },
      {
        name: 'APPLE_KEY_ID',
        type: 'text',
        message: 'Key ID:',
        required: true,
        pattern: '^[A-Z0-9]{10}$',
        patternMessage: 'Key IDs are 10 characters (A-Z, 0-9)',
      },
      {
        name: 'APPLE_PRIVATE_KEY',
        type: 'file',
        message: 'Path to the .p8 key file:',
        placeholder: './AuthKey_ABCDE12345.p8',
        required: true,
        pattern: 'BEGIN PRIVATE KEY',
        patternMessage: "That file doesn't look like a .p8 private key",
      },
      {
        name: 'APPLE_REDIRECT_URI',
        type: 'text',
        message: 'Return URL (https, registered on the Services ID):',
        default: 'https://api.yourapp.com/v1/api/auth/apple/callback',
        pattern: '^https://',
        patternMessage: 'Apple only accepts https return URLs',
      },
      {
        name: 'OAUTH_SUCCESS_REDIRECT',
        type: 'text',
        message: 'Where to send the browser after sign-in:',
        default: 'http://localhost:3000/',
      },
    ],
    enable: (o) => {
      o.userPortal = true;
      o.oauth = { ...o.oauth, apple: true };
    },
  },
  {
    name: 'email-client',
    aliases: ['mailer'],
    title: 'Email client',
    description: 'SendEmail task over SMTP (nodemailer) — Gmail or any SMTP server',
    group: 'integrations',
    registryDependencies: [],
    replaces: ['src/tasks/SendEmail.ts', 'src/tasks/SendEmail.js'],
    docs: "Every enqueue('SendEmail', { to, subject, body }) now sends real mail. Change SMTP settings in .env.",
    prompts: [
      {
        name: 'provider',
        type: 'select',
        message: 'Email provider:',
        options: [
          {
            value: 'gmail',
            label: 'Gmail',
            hint: 'smtp.gmail.com, preconfigured',
            env: { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465' },
          },
          { value: 'custom', label: 'Other (custom SMTP)', hint: "you'll provide host + port" },
        ],
      },
      {
        name: 'SMTP_HOST',
        type: 'text',
        message: 'SMTP host:',
        placeholder: 'smtp.mailtrap.io',
        required: true,
        when: { provider: 'custom' },
      },
      {
        name: 'SMTP_PORT',
        type: 'text',
        message: 'SMTP port:',
        default: '587',
        when: { provider: 'custom' },
      },
      {
        name: 'SMTP_USER',
        type: 'text',
        message: 'Gmail address:',
        placeholder: 'you@gmail.com',
        required: true,
        when: { provider: 'gmail' },
      },
      {
        name: 'SMTP_USER',
        type: 'text',
        message: 'SMTP username / email:',
        placeholder: 'you@example.com',
        required: true,
        when: { provider: 'custom' },
      },
      {
        name: 'SMTP_PASS',
        type: 'password',
        message: 'Gmail app password (16 characters):',
        required: true,
        stripSpaces: true,
        pattern: '^\\S{16}$',
        patternMessage:
          'Gmail app passwords are 16 characters — this looks like a regular password, not an app password',
        when: { provider: 'gmail' },
        note: 'Google no longer accepts your regular password for SMTP. Generate a 16-character App Password: Google Account → Security → 2-Step Verification → App passwords.',
      },
      {
        name: 'SMTP_PASS',
        type: 'password',
        message: 'SMTP password:',
        required: true,
        when: { provider: 'custom' },
      },
      { name: 'SMTP_FROM', type: 'text', message: 'From address:', default: '{{SMTP_USER}}' },
      {
        name: 'APP_URL',
        type: 'text',
        message: 'App URL (used in email links):',
        default: 'http://localhost:3000',
      },
    ],
    enable: (o) => {
      o.mailer = true;
    },
  },
];

const BY_NAME = new Map(
  ITEMS.flatMap((i) => [i.name, ...(i.aliases ?? [])].map((n) => [n, i] as const)),
);

export function getItem(name: string): ItemDef {
  const item = BY_NAME.get(name);
  if (!item) throw new Error(`Unknown registry item "${name}"`);
  return item;
}

/** `names` plus everything they depend on, dependencies first. */
export function withDependencies(names: Iterable<string>): string[] {
  const out: string[] = [];
  const visit = (alias: string, stack: string[]): void => {
    const name = getItem(alias).name;
    if (out.includes(name)) return;
    if (stack.includes(name)) throw new Error(`Dependency cycle: ${[...stack, name].join(' → ')}`);
    for (const dep of getItem(name).registryDependencies) visit(dep, [...stack, name]);
    out.push(name);
  };
  for (const name of names) visit(name, []);
  return out;
}

/**
 * Scaffold options for a registry-mode app of this variant with these items. The base is
 * the server, src/api, src/tasks and the database; everything else comes from the items.
 */
export function registryOptions(
  v: Pick<Variant, 'language' | 'database' | 'modelApi'>,
  items: Iterable<string> = [],
  extra: Partial<ScaffoldOptions> = {},
): ScaffoldOptions {
  const o: ScaffoldOptions = {
    projectName: 'efc-app',
    language: v.language,
    database: v.database,
    ...(v.database === 'postgresql' && { modelApi: v.modelApi }),
    authStrategy: 'http-only',
    cluster: true,
    tasks: true,
    taskBackend: v.database === 'postgresql' ? 'pg-boss' : 'bullmq',
    routeDocs: true,
    userPortal: false,
    adminPortal: false,
    adminFeatures: { ...NO_ADMIN_FEATURES },
    userFeatures: { ...NO_USER_FEATURES },
    rbac: true,
    mailer: false,
    ...extra,
    registry: true,
  };
  for (const name of withDependencies(items)) getItem(name).enable(o);
  return o;
}

/**
 * Files the CLI owns or merges rather than copies: package.json and .env* are merged,
 * the model index and migrations are generated, the rest belongs to the base.
 */
export function isManagedPath(p: string): boolean {
  return (
    p === 'package.json' ||
    p === '.env' ||
    p === '.env.example' ||
    p === 'AGENTS.md' ||
    p === '.gitignore' ||
    p === 'tsconfig.json' ||
    /^efc\.config\.[jt]s$/.test(p) ||
    /^src\/index\.[jt]s$/.test(p) ||
    /^src\/model\/index\.[jt]s$/.test(p) ||
    p.startsWith('src/migrations/')
  );
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Every file `scaffold(opts)` writes, keyed by POSIX path relative to the app. */
export async function renderTree(opts: ScaffoldOptions): Promise<Map<string, string>> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'efc-registry-'));
  // An absolute projectName makes scaffold() write there (no chdir — unavailable in workers).
  const root = path.join(tmp, opts.projectName);
  await scaffold({ ...opts, projectName: root });
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else
        out.set(path.relative(root, abs).split(path.sep).join('/'), await fs.readFile(abs, 'utf8'));
    }
  };
  await walk(root);
  await fs.remove(tmp);
  return out;
}

export interface EnvVar {
  key: string;
  /** Value written to .env. */
  value: string;
  /** Value written to .env.example. */
  example: string;
}

export interface RenderedItem {
  name: string;
  files: { path: string; content: string }[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  env: EnvVar[];
}

export interface RegistryIndexItem {
  name: string;
  title: string;
  description: string;
  group: ItemGroup;
  registryDependencies: string[];
  replaces: string[];
  aliases: string[];
  prompts: ItemPrompt[];
  docs?: string;
  /** Whether the item's routes enqueue tasks (needs a task backend). */
  requiresTasks: boolean;
}

export function parseEnv(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function pkgDeps(text: string | undefined, field: 'dependencies' | 'devDependencies') {
  return (JSON.parse(text ?? '{}')[field] ?? {}) as Record<string, string>;
}

function added(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(b).filter(([k]) => !(k in a)));
}

/**
 * Render every item of one variant. An item's files are what scaffolding with the item adds
 * to (or, for `replaces`, changes in) scaffolding with only its dependencies. Throws if an
 * item isn't self-contained: if it changes another item's or the base's files, or if its
 * files come out differently once every other item is installed too.
 */
export async function renderVariant(v: Variant): Promise<{
  /** The base app's own files (no package.json, .env, config or entry point). */
  base: { path: string; content: string }[];
  items: RenderedItem[];
  index: RegistryIndexItem[];
}> {
  const cache = new Map<string, Promise<Map<string, string>>>();
  const render = (names: string[]) => {
    const key = withDependencies(names).sort().join(',');
    if (!cache.has(key)) cache.set(key, renderTree(registryOptions(v, names)));
    return cache.get(key)!;
  };

  const full = await render(ITEMS.map((i) => i.name));
  const base = await render([]);
  const claimed = new Set([...base.keys()].filter((p) => !isManagedPath(p)));
  const problems: string[] = [];
  const items: RenderedItem[] = [];
  const index: RegistryIndexItem[] = [];

  for (const item of ITEMS) {
    const before = await render(item.registryDependencies);
    const after = await render([item.name]);
    const files: { path: string; content: string }[] = [];
    for (const [p, content] of after) {
      if (isManagedPath(p) || before.get(p) === content) continue;
      if (before.has(p) && !item.replaces?.includes(p)) {
        problems.push(`${v.key}: ${item.name} changes ${p}, which its dependencies already write`);
        continue;
      }
      if (full.get(p) !== content) {
        problems.push(`${v.key}: ${item.name}'s ${p} depends on other items being installed`);
      }
      files.push({ path: p, content });
      claimed.add(p);
    }
    for (const p of before.keys()) {
      if (!after.has(p)) problems.push(`${v.key}: ${item.name} removes ${p}`);
    }
    for (const managed of ['AGENTS.md', 'tsconfig.json', '.gitignore']) {
      if (before.get(managed) !== after.get(managed)) {
        problems.push(`${v.key}: ${item.name} changes ${managed}`);
      }
    }
    for (const p of after.keys()) {
      if (/^(efc\.config|src\/index)\.[jt]s$/.test(p) && before.get(p) !== after.get(p)) {
        problems.push(`${v.key}: ${item.name} changes ${p}`);
      }
    }

    const envBefore = parseEnv(before.get('.env'));
    const envAfter = parseEnv(after.get('.env'));
    const exampleAfter = parseEnv(after.get('.env.example'));
    const env: EnvVar[] = [...envAfter]
      .filter(([k]) => !envBefore.has(k))
      .map(([key, value]) => ({ key, value, example: exampleAfter.get(key) ?? value }));

    files.sort((a, b) => a.path.localeCompare(b.path));
    items.push({
      name: item.name,
      files,
      dependencies: added(
        pkgDeps(before.get('package.json'), 'dependencies'),
        pkgDeps(after.get('package.json'), 'dependencies'),
      ),
      devDependencies: added(
        pkgDeps(before.get('package.json'), 'devDependencies'),
        pkgDeps(after.get('package.json'), 'devDependencies'),
      ),
      env,
    });
    index.push({
      name: item.name,
      title: item.title,
      description: item.description,
      group: item.group,
      registryDependencies: item.registryDependencies,
      replaces: item.replaces ?? [],
      aliases: item.aliases ?? [],
      prompts: item.prompts ?? [],
      ...(item.docs ? { docs: item.docs } : {}),
      requiresTasks: files.some(
        (f) =>
          f.content.includes("from 'express-file-cluster/tasks'") && /\benqueue\(/.test(f.content),
      ),
    });
  }

  for (const p of full.keys()) {
    if (!isManagedPath(p) && !claimed.has(p)) problems.push(`${v.key}: no item owns ${p}`);
  }
  if (problems.length)
    throw new Error(`Registry items aren't self-contained:\n  ${problems.join('\n  ')}`);
  const baseFiles = [...base]
    .filter(([p]) => !isManagedPath(p))
    .map(([p, content]) => ({ path: p, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { base: baseFiles, items, index };
}

/**
 * efc.json for a freshly scaffolded app: its variant, the items it was created with, and the
 * hash of every file efc wrote — so `efc add` can later tell untouched files from changed ones.
 */
export async function writeManifest(
  dest: string,
  opts: ScaffoldOptions,
  items: string[],
): Promise<void> {
  const pkg = (await fs.readJson(path.join(dest, 'package.json'))) as {
    dependencies: Record<string, string>;
  };
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else {
        const rel = path.relative(dest, abs).split(path.sep).join('/');
        if (!isManagedPath(rel)) files[rel] = sha256(await fs.readFile(abs, 'utf8'));
      }
    }
  };
  await walk(dest);
  const manifest = {
    registry: (pkg.dependencies['express-file-cluster'] ?? '').replace(/^[^\d]*/, ''),
    language: opts.language,
    database: opts.database,
    modelApi: opts.database === 'postgresql' ? (opts.modelApi ?? 'defineTable') : 'defineModel',
    tasks: opts.tasks ? (opts.taskBackend ?? 'bullmq') : null,
    items: [...withDependencies(items)].sort(),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  await fs.writeFile(path.join(dest, 'efc.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// ── Item prompts (same rules as `efc add` in core's src/cli/registry.ts) ──────────────────

export type PromptAnswers = Record<string, string>;

const isEnvName = (name: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(name);

/** Whether a prompt applies, given the answers so far. */
export function promptApplies(p: ItemPrompt, answers: PromptAnswers): boolean {
  return Object.entries(p.when ?? {}).every(([k, v]) => answers[k] === v);
}

/** The default for a prompt, with `{{NAME}}` filled in from earlier answers. */
export function promptDefault(p: ItemPrompt, answers: PromptAnswers): string | undefined {
  return p.default?.replace(/\{\{(\w+)\}\}/g, (_, k: string) => answers[k] ?? '');
}

/** The stored value for an answer, or why it's not acceptable. */
export function normalizeAnswer(
  p: ItemPrompt,
  raw: string,
  cwd: string = process.cwd(),
): { value: string } | { error: string } {
  let value = p.stripSpaces ? raw.replace(/\s/g, '') : raw.trim();
  if (!value) return p.required ? { error: 'Required' } : { value };
  if (p.type === 'file') {
    const file = path.resolve(cwd, value.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(file)) return { error: `No such file: ${file}` };
    value = fs.readFileSync(file, 'utf8').trim();
  }
  if (p.pattern && !new RegExp(p.pattern).test(value)) {
    return { error: p.patternMessage ?? `Must match ${p.pattern}` };
  }
  if (p.type === 'file') value = value.replace(/\r?\n/g, '\\n');
  return { value };
}

/** Env values from the answers: answers named like env vars, plus what chosen options set. */
export function envFromAnswers(
  prompts: ItemPrompt[],
  answers: PromptAnswers,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of prompts) {
    if (!(p.name in answers) || !promptApplies(p, answers)) continue;
    if (isEnvName(p.name)) env[p.name] = answers[p.name]!;
    const chosen = p.options?.find((o) => o.value === answers[p.name]);
    Object.assign(env, chosen?.env ?? {});
  }
  return env;
}

/** The prompts of these items, in order, without repeats. */
export function itemPrompts(items: string[]): ItemPrompt[] {
  const out: ItemPrompt[] = [];
  for (const name of items) {
    for (const p of getItem(name).prompts ?? []) {
      const dup = out.some(
        (q) => q.name === p.name && JSON.stringify(q.when) === JSON.stringify(p.when),
      );
      if (!dup) out.push(p);
    }
  }
  return out;
}

/** Sets vars in a .env file: replaces their lines, appends the rest. */
export async function setEnvValues(file: string, env: Record<string, string>): Promise<void> {
  const line = (k: string, v: string) =>
    !/[\s#"'`]/.test(v)
      ? `${k}=${v}`
      : v.includes("'")
        ? `${k}="${v.replace(/"/g, '\\"')}"`
        : `${k}='${v}'`;
  const lines = (await fs.pathExists(file)) ? (await fs.readFile(file, 'utf8')).split('\n') : [];
  const rest = { ...env };
  const out = lines.map((l) => {
    const key = /^([A-Za-z0-9_]+)=/.exec(l)?.[1];
    if (key === undefined || !(key in rest)) return l;
    const v = rest[key]!;
    delete rest[key];
    return line(key, v);
  });
  for (const [k, v] of Object.entries(rest)) out.push(line(k, v));
  await fs.writeFile(file, out.join('\n'));
}
