import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AdminFeatures {
  userManagement: boolean;
  adminManagement: boolean;
  analytics: boolean;
  contentManagement: boolean;
  billingManagement: boolean;
  supportManagement: boolean;
  notificationsAndLogs: boolean;
  systemSettings: boolean;
}

export interface UserFeatures {
  profileViewing: boolean;
  forgotPassword: boolean;
  accountSecurity: boolean;
  emailVerification: boolean;
  accountSettings: boolean;
  notifications: boolean;
  filesAndMedia: boolean;
  apiAndBilling: boolean;
  support: boolean;
}

export const NO_ADMIN_FEATURES: AdminFeatures = {
  userManagement: false,
  adminManagement: false,
  analytics: false,
  contentManagement: false,
  billingManagement: false,
  supportManagement: false,
  notificationsAndLogs: false,
  systemSettings: false,
};

export const NO_USER_FEATURES: UserFeatures = {
  profileViewing: false,
  forgotPassword: false,
  accountSecurity: false,
  emailVerification: false,
  accountSettings: false,
  notifications: false,
  filesAndMedia: false,
  apiAndBilling: false,
  support: false,
};

export interface ScaffoldOptions {
  projectName: string;
  language: 'typescript' | 'javascript';
  database: 'mongodb' | 'postgresql';
  authStrategy: 'http-only' | 'localStorage';
  cluster: boolean;
  tasks: boolean;
  taskBackend?: 'bullmq' | 'pg-boss';
  routeDocs: boolean;
  userPortal: boolean;
  adminPortal: boolean;
  adminFeatures: AdminFeatures;
  userFeatures: UserFeatures;
  rbac: boolean;
  mailer: boolean;
  smtpProvider?: 'gmail' | 'custom';
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPass?: string;
  /**
   * Model API on PostgreSQL: `defineTable` (default — foreign keys, relations, Prisma-style
   * queries) or the portable `defineModel` (same API as on MongoDB). MongoDB always uses
   * `defineModel`.
   */
  modelApi?: 'defineTable' | 'defineModel';
  /**
   * Registry mode (`efc add`): every file renders the same way whatever else is generated,
   * so a feature's files can be added to an app on their own. Login and the password flows
   * always handle both User and Admin (and both models come with auth), routes always send
   * mail through the SendEmail task, and models declare no back-relations.
   */
  registry?: boolean;
  /** OAuth sign-in providers (needs the User model — auth). */
  oauth?: { google?: boolean; apple?: boolean };
}

/** Whether any OAuth sign-in provider is generated. */
function usesOAuth(opts: ScaffoldOptions): boolean {
  return !!(opts.oauth?.google || opts.oauth?.apple);
}

/** Which principals the auth routes handle. */
function principals(opts: ScaffoldOptions): { user: boolean; admin: boolean } {
  return {
    user: !!opts.registry || opts.userPortal,
    admin: !!opts.registry || opts.adminPortal,
  };
}

/** Whether routes email their tokens through the SendEmail task (vs. a TODO). */
function sendsMail(opts: ScaffoldOptions): boolean {
  return !!opts.registry || opts.mailer;
}

/** Whether the generated models are `defineTable` (PostgreSQL-native) ones. */
export function usesTables(opts: ScaffoldOptions): boolean {
  return opts.database === 'postgresql' && opts.modelApi !== 'defineModel';
}

/**
 * Code for model calls in generated routes, in the vocabulary of the chosen API:
 * `defineModel` (`User.findOne({ email })`) or `defineTable` (`User.findFirst({ where: … })`).
 * Arguments are source text.
 */
function orm(opts: ScaffoldOptions) {
  const t = usesTables(opts);
  const where = (filter: string) =>
    filter.replace(/\s/g, '') === '{}' ? '' : `{ where: ${filter} }`;
  const byId = (id: string) => (id === 'id' ? '{ id }' : `{ id: ${id} }`);
  return {
    findOne: (m: string, filter: string) =>
      t ? `${m}.findFirst({ where: ${filter} })` : `${m}.findOne(${filter})`,
    findById: (m: string, id: string) =>
      t ? `${m}.findUnique({ where: ${byId(id)} })` : `${m}.findById(${id})`,
    find: (m: string, filter: string) =>
      t ? `${m}.findMany(${where(filter)})` : `${m}.find(${filter})`,
    count: (m: string, filter: string) =>
      t ? `${m}.count(${where(filter)})` : `${m}.count(${filter})`,
    create: (m: string, data: string) =>
      t ? `${m}.create({ data: ${data} })` : `${m}.create(${data})`,
    update: (m: string, id: string, data: string) =>
      t ? `${m}.update({ where: ${byId(id)}, data: ${data} })` : `${m}.update(${id}, ${data})`,
    delete: (m: string, id: string) =>
      t ? `${m}.delete({ where: ${byId(id)} })` : `${m}.delete(${id})`,
  };
}

/** The models `scaffold()` generates for these options. */
export function generatedModels(opts: ScaffoldOptions): Set<string> {
  const uf = opts.userFeatures;
  const af = opts.adminFeatures;
  const user = opts.userPortal;
  const admin = opts.adminPortal;
  const m = new Set<string>();
  // Admin "user management" operates on the User collection even when there's
  // no separate self-service user portal, so the model must exist for it too.
  if (user || (admin && af.userManagement)) m.add('User');
  if (admin) m.add('Admin');
  // Registry mode: auth always handles both principals, so it always brings both models.
  if (opts.registry && (user || admin)) m.add('User').add('Admin');
  if (user && uf.accountSecurity) m.add('Session');
  if ((user && uf.notifications) || (admin && af.notificationsAndLogs)) m.add('Notification');
  if (user && uf.filesAndMedia) m.add('File');
  if ((user && uf.support) || (admin && af.supportManagement)) m.add('SupportTicket');
  if (admin && af.notificationsAndLogs) m.add('AuditLog');
  if (user && uf.apiAndBilling) m.add('Subscription').add('Invoice').add('ApiKey');
  if (usesOAuth(opts)) m.add('OAuthAccount');
  if (admin && af.billingManagement) m.add('Plan').add('Coupon');
  if (opts.rbac && admin && af.adminManagement) m.add('Role');
  if (admin && af.contentManagement) m.add('FAQ').add('Blog').add('Category');
  // Registry mode: a reference is always a foreign key, so its target comes along.
  if (opts.registry && m.has('Subscription')) m.add('Plan');
  return m;
}

/** `import { defineTable }` / `import { defineModel }` and the function's name. */
function modelApi(opts: ScaffoldOptions): { name: string; import: string } {
  const name = usesTables(opts) ? 'defineTable' : 'defineModel';
  return { name, import: `import { ${name} } from 'express-file-cluster';` };
}

/**
 * A reference field: on defineTable, a real foreign key when its target model is generated;
 * otherwise the plain id string `legacy` describes (defineModel, or no such model).
 */
function refField(
  opts: ScaffoldOptions,
  r: {
    field: string;
    target: string;
    legacy: string;
    required?: boolean;
    onDelete: 'cascade' | 'setNull' | 'restrict';
  },
): string {
  if (!usesTables(opts) || !generatedModels(opts).has(r.target)) return r.legacy;
  const opts2 = `${r.required ? ', required: true' : ''}${r.onDelete === 'restrict' ? '' : `, onDelete: '${r.onDelete}'`}`;
  return `  ${(r.field + ':').padEnd(13)}{ type: 'uuid', ref: '${r.target}'${opts2} },`;
}

/** The `relations` option (defineTable): back-relations whose models are generated. */
function relationsOption(
  opts: ScaffoldOptions,
  rels: { name: string; kind: 'hasMany' | 'hasOne'; target: string; foreignKey: string }[],
): string {
  if (!usesTables(opts) || opts.registry) return '';
  const models = generatedModels(opts);
  const live = rels.filter((r) => models.has(r.target));
  if (live.length === 0) return '';
  const lines = live.map(
    (r) => `    ${r.name}: { ${r.kind}: '${r.target}', foreignKey: '${r.foreignKey}' },`,
  );
  return `, {\n  relations: {\n${lines.join('\n')}\n  },\n}`;
}

export async function scaffold(opts: ScaffoldOptions): Promise<void> {
  const dest = path.resolve(process.cwd(), opts.projectName);
  await fs.ensureDir(dest);

  const uf = opts.userFeatures;
  const models = generatedModels(opts);

  await writePackageJson(dest, opts);
  await writeTsConfig(dest, opts);
  await writeEfcConfig(dest, opts);
  await writeEntryPoint(dest, opts);
  await writeGitignore(dest);
  await writeAgentsMd(dest, opts);
  await writeEnvFiles(dest, opts);
  await writeExampleRoute(dest, opts);
  if (models.has('User')) await writeUserModel(dest, opts);
  if (models.has('Admin')) await writeAdminModel(dest, opts);
  if (!opts.registry || opts.userPortal || opts.adminPortal) await writeAuthRoutes(dest, opts);
  if (opts.adminPortal) await writeAdminRoutes(dest, opts);
  if (opts.userPortal && uf.profileViewing) await writeUserRoutes(dest, opts);
  if (opts.tasks) await writeExampleTask(dest, opts);
  // Extended models — only generated when a feature that uses them is selected
  const extended: [string, (dest: string, opts: ScaffoldOptions) => Promise<void>][] = [
    ['Session', writeSessionModel],
    ['Notification', writeNotificationModel],
    ['File', writeFileModel],
    ['SupportTicket', writeSupportTicketModel],
    ['AuditLog', writeAuditLogModel],
    ['Subscription', writeSubscriptionModel],
    ['Plan', writePlanModel],
    ['Invoice', writeInvoiceModel],
    ['ApiKey', writeApiKeyModel],
    ['Role', writeRoleModel],
    ['FAQ', writeFAQModel],
    ['Blog', writeBlogModel],
    ['Category', writeCategoryModel],
    ['Coupon', writeCouponModel],
  ];
  for (const [name, write] of extended) if (models.has(name)) await write(dest, opts);
  if (models.has('OAuthAccount')) await writeOAuthAccountModel(dest, opts);
  if (usesOAuth(opts)) await writeOAuth(dest, opts);
  if (usesTables(opts)) await writeModelIndex(dest, opts);
  // Extended routes — gated by the same per-feature flags as their models
  if (opts.userPortal) await writeAuthExtendedRoutes(dest, opts);
  if (opts.userPortal) await writeUserExtendedRoutes(dest, opts);
  if (opts.userPortal && uf.apiAndBilling) await writeUserBillingRoutes(dest, opts);
  if (opts.userPortal && uf.support) await writeSupportRoutes(dest, opts);
  if (opts.adminPortal) await writeAdminExtendedRoutes(dest, opts);
  await writeInitMigration(dest, opts);
}

async function writePackageJson(dest: string, opts: ScaffoldOptions): Promise<void> {
  const deps: Record<string, string> = {
    'express-file-cluster': '^0.9.0',
  };
  if (opts.database === 'mongodb') deps['mongoose'] = '^9.7.2';
  if (opts.database === 'postgresql') {
    deps['pg'] = '^8.11.0';
    deps['drizzle-orm'] = '^0.45.0';
  }
  if (opts.tasks && opts.taskBackend === 'bullmq') deps['bullmq'] = '^5.0.0';
  if (opts.tasks && opts.taskBackend === 'pg-boss') deps['pg-boss'] = '^12.0.0';
  if (opts.mailer) deps['nodemailer'] = '^6.9.0';
  if (usesOAuth(opts)) deps['jose'] = '^6.2.3';
  // Registry mode: the base has no auth, so no password hashing either.
  const auth = !opts.registry || opts.userPortal || opts.adminPortal;
  if (auth) deps['bcrypt'] = '^5.1.0';

  const devDeps: Record<string, string> = {
    vitest: '^5.0.3',
  };
  if (opts.language === 'typescript') {
    // JavaScript projects need neither: `efc build prod` copies them, `efc start dev` uses node --watch.
    devDeps['tsup'] = '^8.2.0';
    devDeps['typescript'] = '^5.5.0';
    devDeps['@types/node'] = '^22.0.0';
    devDeps['@types/express'] = '^4.17.21';
    devDeps['tsx'] = '^4.0.0';
    if (opts.mailer) devDeps['@types/nodemailer'] = '^6.4.0';
    if (auth) devDeps['@types/bcrypt'] = '^5.0.0';
    if (opts.database === 'postgresql') devDeps['@types/pg'] = '^8.11.0';
  }

  const pkg = {
    name: opts.projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'efc start dev',
      build: 'efc build prod',
      start: 'efc start prod',
      test: 'efc run tests',
      'db:migrate': 'efc db migrate',
      'db:rollback': 'efc db rollback',
      'db:seed': 'efc db seed',
      'db:studio': 'efc db studio',
    },
    dependencies: deps,
    devDependencies: devDeps,
  };

  await fs.writeJson(path.join(dest, 'package.json'), pkg, { spaces: 2 });
}

async function writeTsConfig(dest: string, opts: ScaffoldOptions): Promise<void> {
  if (opts.language !== 'typescript') return;
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: './dist',
    },
    // No explicit rootDir: efc.config.ts lives at the project root, outside src/, and
    // src/index.ts imports it. `efc build prod` only uses this config for `tsc --noEmit`
    // typechecking — tsup writes the actual output (dist/src/**, dist/efc.config.js),
    // so leaving rootDir implicit here has no effect on the production build's output layout.
    include: ['src/**/*', 'efc.config.ts'],
    exclude: ['node_modules', 'dist'],
  };
  await fs.writeJson(path.join(dest, 'tsconfig.json'), config, { spaces: 2 });
}

async function writeEfcConfig(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  // pg-boss stores jobs in the app's own Postgres (databaseUrl); BullMQ needs Redis.
  const tasks = !opts.tasks
    ? 'false'
    : opts.taskBackend === 'pg-boss'
      ? `{ backend: 'pg-boss', concurrency: 5 }`
      : `{ backend: 'bullmq', concurrency: 5, redisUrl: process.env.REDIS_URL }`;

  const ts = opts.language === 'typescript';
  // JavaScript gets a JSDoc type instead of TypeScript syntax, so editors still check it.
  const typeImport = ts ? "import type { EFCConfig } from 'express-file-cluster';\n\n" : '';
  const declaration = ts
    ? 'const config: EFCConfig = {'
    : "/** @type {import('express-file-cluster').EFCConfig} */\nconst config = {";
  const content = `${typeImport}// The framework never reads process.env itself — every runtime value it needs is read
// here, explicitly, and passed in. Edit .env to change values; edit this file to change
// which env vars are wired up or add new ones.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

${declaration}
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  cookieDomain: process.env.COOKIE_DOMAIN,
  cors: corsOrigins ? { origin: corsOrigins } : true,
  authStrategy: '${opts.authStrategy}',
  tasks: ${tasks},
  // Cache + session-revocation store (logout really invalidates tokens). Redis when
  // REDIS_URL is set — shared by every instance; otherwise an in-memory store shared by
  // this machine's workers, emptied on restart.
  cache: process.env.REDIS_URL ? { backend: 'redis', url: process.env.REDIS_URL } : { backend: 'memory' },
  globalMiddlewares: [],
};

export default config;
`;
  await fs.outputFile(path.join(dest, `efc.config.${ext}`), content);
}

async function writeEntryPoint(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  // Only emit `cluster: false` on opt-out — a literal `cluster: true` would override
  // ignite()'s NODE_ENV-aware default and cluster under `efc start dev` too.
  const clusterLine = opts.cluster ? '' : '\n  cluster: false,';
  const content = `import { ignite, gracefulShutdown } from 'express-file-cluster';
import config from '../efc.config.js';

// Every runtime value (PORT, DATABASE_URL, JWT_SECRET, CORS_ORIGINS, ...) is wired from
// .env in efc.config.${ext} and spread in below — ignite() itself never touches process.env
// for these, so this object is the single source of truth for what's actually applied.
ignite({
  ...config,${clusterLine}
}).then(gracefulShutdown).catch(console.error);
`;
  await fs.outputFile(path.join(dest, 'src', `index.${ext}`), content);
}

async function writeGitignore(dest: string): Promise<void> {
  await fs.outputFile(
    path.join(dest, '.gitignore'),
    'node_modules/\ndist/\n.env\n.env.local\n*.log\n',
  );
}

// Points AI coding agents at the docs bundled with the installed framework version, so
// they read the real API instead of guessing it.
async function writeAgentsMd(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const D = 'node_modules/express-file-cluster/dist/docs';
  const engine = opts.database === 'postgresql' ? 'PostgreSQL' : 'MongoDB';
  const content = `# AGENTS.md

This is an **express-file-cluster (EFC)** app (${opts.language === 'typescript' ? 'TypeScript' : 'JavaScript'}, ${engine}).
EFC's API is probably not in your training data — **read its docs before writing code**, and
don't use any EFC import, option or method you can't find in them.

## Read the docs first

The docs for the exact installed version ship inside the package, under \`${D}/\`:

1. \`${D}/skills/api-surface.md\` — every public export and signature
2. \`${D}/skills/what-not-to-invent.md\` — things that do NOT exist
3. \`${D}/index.md\`, then the page for your task:
   - routes & URL params — \`core-concepts/file-based-routing.md\`, \`skills/routing-rules.md\`
   - request validation — \`guides/validation.md\`
   - models & queries — \`guides/database.md\`, \`api-reference/db.md\`${opts.database === 'postgresql' ? ', `api-reference/table.md` (PostgreSQL-native `defineTable`)' : ''}
   - migrations — \`guides/migrations.md\`
   - auth & roles — \`guides/authentication.md\`, \`guides/rbac.md\`
   - background tasks — \`core-concepts/background-tasks.md\`
   - config & boot — \`api-reference/ignite.md\`

Search them: \`grep -rn "<term>" ${D}\`

Optional — the same docs over MCP, with search and scaffolding tools:
\`claude mcp add efc -- npx -y express-file-cluster-mcp\`
(other clients: command \`npx\`, args \`["-y", "express-file-cluster-mcp"]\`).

## Project conventions

- \`src/api/**\` — every file is a route (\`users/[id].${ext}\` → \`/v1/api/users/:id\`); export
  uppercase \`GET\`/\`POST\`/… handlers.
- \`src/tasks/*.${ext}\` — background tasks; the file name is the task name (not recursive).
${
  usesTables(opts)
    ? `- \`src/model/*.${ext}\` — \`defineTable\` models (PostgreSQL-native, Prisma-style queries:
  \`findMany({ where, include })\`, \`create({ data })\`, \`update({ where, data })\`). A \`ref\` is a
  foreign key; ${opts.registry ? "add back-relations to a model's `relations` when you need `include`" : "back-relations are in each model's `relations`"}. \`src/model/index.${ext}\` imports
  them all${opts.language === 'typescript' ? ' and declares `Tables` (typed `include`)' : ''} — add new models there.`
    : `- \`src/model/*.${ext}\` — \`defineModel\` models.`
}
- \`src/index.${ext}\` is the entry point; it imports \`efc.config.${ext}\` and passes it to \`ignite()\`.
- Only three import paths exist: \`express-file-cluster\`, \`express-file-cluster/auth\`,
  \`express-file-cluster/tasks\`.
${
  opts.registry
    ? `- Ready-made features (auth, user/admin portals, billing, mailer…) come from the registry:
  \`npx efc list\`, then \`npx efc add <item> --yes\` — check it before hand-writing auth or CRUD
  (\`${D}/cli/add.md\`). \`efc.json\` tracks what was added; commit it.
`
    : ''
}
## Commands

\`\`\`bash
npx efc start dev        # dev server with reload
npx efc db migrate       # run migrations
npx efc build prod       # type-check + production build
npx efc doctor           # diagnose the setup
\`\`\`
`;
  await fs.outputFile(path.join(dest, 'AGENTS.md'), content);
}

async function writeEnvFiles(dest: string, opts: ScaffoldOptions): Promise<void> {
  const secret = crypto.randomBytes(64).toString('hex');
  const projectName = path.basename(dest);
  const dbUrl =
    opts.database === 'mongodb'
      ? `mongodb://localhost:27017/${projectName}`
      : `postgresql://localhost:5432/${projectName}`;
  const dbExampleUrl =
    opts.database === 'mongodb'
      ? `mongodb://localhost:27017/${projectName}`
      : `postgresql://user:password@localhost:5432/${projectName}`;

  const isGmail = opts.mailer && opts.smtpProvider !== 'custom';
  const resolvedHost = isGmail ? 'smtp.gmail.com' : (opts.smtpHost ?? 'smtp.gmail.com');
  const resolvedPort = isGmail ? '465' : (opts.smtpPort ?? '587');
  const passComment = isGmail
    ? ' # Gmail App Password (16 chars) — NOT your regular Gmail password. Generate at: Google Account > Security > 2-Step Verification > App passwords'
    : '';

  const smtpVars = opts.mailer
    ? `\nAPP_URL=http://localhost:3000\nSMTP_HOST=${resolvedHost}\nSMTP_PORT=${resolvedPort}\nSMTP_USER=${opts.smtpUser ?? ''}\nSMTP_PASS=${opts.smtpPass ?? ''}${passComment}\nSMTP_FROM=${opts.smtpUser ?? 'noreply@example.com'}\n`
    : '';
  const smtpExample = opts.mailer
    ? `\nAPP_URL=http://localhost:3000\nSMTP_HOST=${resolvedHost}\nSMTP_PORT=${resolvedPort}\nSMTP_USER=your@email.com\nSMTP_PASS=${isGmail ? 'your_16_char_app_password' : 'your_smtp_password'}${passComment}\nSMTP_FROM=noreply@yourapp.com\n`
    : '';
  // Only BullMQ needs Redis — and `efc tasks failed` picks its backend from REDIS_URL.
  const redis =
    opts.tasks && opts.taskBackend !== 'pg-boss' ? '\nREDIS_URL=redis://localhost:6379' : '';
  const oauth = opts.oauth ?? {};
  const oauthVars = [
    ...(oauth.google
      ? [
          ['GOOGLE_CLIENT_ID', '', 'your-client-id.apps.googleusercontent.com'],
          ['GOOGLE_CLIENT_SECRET', '', 'your-client-secret'],
          [
            'GOOGLE_REDIRECT_URI',
            'http://localhost:3000/v1/api/auth/google/callback',
            'https://api.yourapp.com/v1/api/auth/google/callback',
          ],
        ]
      : []),
    ...(oauth.apple
      ? [
          ['APPLE_CLIENT_ID', '', 'com.yourapp.signin'],
          ['APPLE_TEAM_ID', '', 'ABCDE12345'],
          ['APPLE_KEY_ID', '', 'FGHIJ67890'],
          [
            'APPLE_PRIVATE_KEY',
            '',
            '-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----',
          ],
          [
            'APPLE_REDIRECT_URI',
            'https://api.yourapp.com/v1/api/auth/apple/callback',
            'https://api.yourapp.com/v1/api/auth/apple/callback',
          ],
        ]
      : []),
    ...(usesOAuth(opts)
      ? [['OAUTH_SUCCESS_REDIRECT', 'http://localhost:3000/', 'https://yourapp.com/']]
      : []),
  ];
  const oauthEnv = oauthVars.map(([k, v]) => `\n${k}=${v}`).join('');
  const oauthExample = oauthVars.map(([k, , ex]) => `\n${k}=${ex}`).join('');
  const dotenv = `PORT=3000\nNODE_ENV=development\nDATABASE_URL=${dbUrl}\nJWT_SECRET=${secret}${redis}\nCORS_ORIGINS=http://localhost:3000${smtpVars}${oauthEnv}`;
  const example = `PORT=3000\nNODE_ENV=development\nDATABASE_URL=${dbExampleUrl}\nJWT_SECRET=<generate with: openssl rand -hex 64>${redis}\nCORS_ORIGINS=http://localhost:3000,https://yourapp.com${smtpExample}${oauthExample}`;
  await fs.outputFile(path.join(dest, '.env'), dotenv);
  await fs.outputFile(path.join(dest, '.env.example'), example);
}

async function writeExampleRoute(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const metaTs = opts.routeDocs
    ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Health check — returns server status and current timestamp.',\n    response: { status: 200, body: { status: 'OK', timestamp: '2024-01-01T00:00:00.000Z' } },\n  },\n};\n\n`
    : '';
  const metaJs = opts.routeDocs
    ? `export const meta = {\n  GET: {\n    description: 'Health check — returns server status and current timestamp.',\n    response: { status: 200, body: { status: 'OK', timestamp: '2024-01-01T00:00:00.000Z' } },\n  },\n};\n\n`
    : '';
  const content =
    opts.language === 'typescript'
      ? `import type { Request, Response } from 'express';\n${metaTs}export const GET = async (_req: Request, res: Response) => {\n  res.json({ status: 'OK', timestamp: new Date().toISOString() });\n};\n`
      : `${metaJs}export const GET = async (_req, res) => {\n  res.json({ status: 'OK', timestamp: new Date().toISOString() });\n};\n`;
  await fs.outputFile(path.join(dest, 'src', 'api', `health.${ext}`), content);
}

async function writeExampleTask(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';

  const tsMailer = `import { defineTask } from 'express-file-cluster/tasks';
import nodemailer from 'nodemailer';

interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default defineTask<SendEmailPayload>(async (payload) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: payload.to,
    subject: payload.subject,
    html: payload.body,
  });
});
`;

  const jsMailer = `import { defineTask } from 'express-file-cluster/tasks';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default defineTask(async (payload) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: payload.to,
    subject: payload.subject,
    html: payload.body,
  });
});
`;

  const tsStub = `import { defineTask } from 'express-file-cluster/tasks';

interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
}

export default defineTask<SendEmailPayload>(async (payload) => {
  // TODO: wire up your mailer
  console.log('[SendEmail] Sending to', payload.to);
});
`;

  const jsStub = `import { defineTask } from 'express-file-cluster/tasks';

export default defineTask(async (payload) => {
  // TODO: wire up your mailer
  console.log('[SendEmail] Sending to', payload.to);
});
`;

  const content = opts.mailer
    ? opts.language === 'typescript'
      ? tsMailer
      : jsMailer
    : opts.language === 'typescript'
      ? tsStub
      : jsStub;

  await fs.outputFile(path.join(dest, 'src', 'tasks', `SendEmail.${ext}`), content);
}

async function writeUserModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';

  const content = `${modelApi(opts).import}

export const User = ${modelApi(opts).name}('User', {
  name:               { type: 'string',  required: true },
  email:              { type: 'string',  required: true, unique: true },
  password:           { type: 'string',  required: true },
  role:               { type: 'string',  required: true, default: 'user' },
  avatar:             { type: 'string' },
  isVerified:         { type: 'boolean', default: false },
  isActive:           { type: 'boolean', default: true },
  verifyToken:        { type: 'string' },
  resetToken:         { type: 'string' },
  resetTokenExpiry:   { type: 'date' },
  refreshToken:       { type: 'string' },
  refreshTokenExpiry: { type: 'date' },
}${relationsOption(opts, [
    { name: 'sessions', kind: 'hasMany', target: 'Session', foreignKey: 'user' },
    { name: 'notifications', kind: 'hasMany', target: 'Notification', foreignKey: 'user' },
    { name: 'files', kind: 'hasMany', target: 'File', foreignKey: 'user' },
    { name: 'tickets', kind: 'hasMany', target: 'SupportTicket', foreignKey: 'user' },
    { name: 'subscriptions', kind: 'hasMany', target: 'Subscription', foreignKey: 'user' },
    { name: 'invoices', kind: 'hasMany', target: 'Invoice', foreignKey: 'user' },
    { name: 'apiKeys', kind: 'hasMany', target: 'ApiKey', foreignKey: 'user' },
  ])});
`;

  await fs.outputFile(path.join(dest, 'src', 'model', `User.${ext}`), content);
}

async function writeAdminModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';

  const content = `${modelApi(opts).import}

export const Admin = ${modelApi(opts).name}('Admin', {
  name:               { type: 'string',  required: true },
  email:              { type: 'string',  required: true, unique: true },
  password:           { type: 'string',  required: true },
  role:               { type: 'string',  required: true, default: 'admin' },
  permissions:        { type: 'array',   of: 'string', default: [] },
  isActive:           { type: 'boolean', default: true },
  resetToken:         { type: 'string' },
  resetTokenExpiry:   { type: 'date' },
  refreshToken:       { type: 'string' },
  refreshTokenExpiry: { type: 'date' },
}${relationsOption(opts, [
    { name: 'assignedTickets', kind: 'hasMany', target: 'SupportTicket', foreignKey: 'assignedTo' },
    { name: 'auditLogs', kind: 'hasMany', target: 'AuditLog', foreignKey: 'admin' },
    { name: 'posts', kind: 'hasMany', target: 'Blog', foreignKey: 'author' },
  ])});
`;

  await fs.outputFile(path.join(dest, 'src', 'model', `Admin.${ext}`), content);
}

async function writeAuthRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const db = orm(opts);
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';

  const loginMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Authenticate a user or admin and issue a JWT.',\n    request: { body: { email: 'user@example.com', password: 'user' } },\n    response: { status: 200, body: { message: 'Logged in as user' } },\n  },\n};\n\n`
      : `export const meta = {\n  POST: {\n    description: 'Authenticate a user or admin and issue a JWT.',\n    request: { body: { email: 'user@example.com', password: 'user' } },\n    response: { status: 200, body: { message: 'Logged in as user' } },\n  },\n};\n\n`
    : '';

  // Only reference the models for the portals actually being generated —
  // referencing both unconditionally broke builds when only one portal was selected.
  const { user: hasUser, admin: hasAdmin } = principals(opts);
  const hasModels = hasUser || hasAdmin;

  const loginDbImports = hasModels
    ? `import bcrypt from 'bcrypt';\nimport crypto from 'node:crypto';\n${hasUser ? `import { User } from '../../model/User.js';\n` : ''}${hasAdmin ? `import { Admin } from '../../model/Admin.js';\n` : ''}`
    : '';

  const loginBody =
    hasAdmin && hasUser
      ? `  const admin = await ${db.findOne('Admin', `{ email }`)};
  if (admin) {
    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    if (!admin.isActive) return res.status(403).json({ error: 'Account suspended' });
    await issueToken(res, { id: admin.id, role: admin.role, email: admin.email });
    await issueRefreshToken(res, Admin, admin.id);
    return res.json({ message: 'Logged in as admin' });
  }

  const user = await ${db.findOne('User', `{ email }`)};
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.isActive) return res.status(403).json({ error: 'Account suspended' });
  await issueToken(res, { id: user.id, role: user.role, email: user.email });
  await issueRefreshToken(res, User, user.id);
  res.json({ message: 'Logged in' });`
      : hasAdmin
        ? `  const admin = await ${db.findOne('Admin', `{ email }`)};
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, admin.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  if (!admin.isActive) return res.status(403).json({ error: 'Account suspended' });
  await issueToken(res, { id: admin.id, role: admin.role, email: admin.email });
  await issueRefreshToken(res, Admin, admin.id);
  res.json({ message: 'Logged in as admin' });`
        : `  const user = await ${db.findOne('User', `{ email }`)};
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.isActive) return res.status(403).json({ error: 'Account suspended' });
  await issueToken(res, { id: user.id, role: user.role, email: user.email });
  await issueRefreshToken(res, User, user.id);
  res.json({ message: 'Logged in' });`;

  const loginContent = hasModels
    ? ts
      ? `import { issueToken } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${loginDbImports}${loginMeta}const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

async function issueRefreshToken(
  res: Response,
  model: ${
    usesTables(opts)
      ? '{ update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> }'
      : '{ update: (id: string, data: Record<string, unknown>) => Promise<unknown> }'
  },
  id: string,
): Promise<void> {
  const refreshToken = crypto.randomBytes(40).toString('hex');
  await ${db.update('model', 'id', '{ refreshToken, refreshTokenExpiry: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) }')};
  res.cookie('efc_refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export const POST = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

${loginBody}
};
`
      : `import { issueToken } from 'express-file-cluster/auth';
${loginDbImports}${loginMeta}const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

async function issueRefreshToken(res, model, id) {
  const refreshToken = crypto.randomBytes(40).toString('hex');
  await ${db.update('model', 'id', '{ refreshToken, refreshTokenExpiry: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) }')};
  res.cookie('efc_refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export const POST = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

${loginBody}
};
`
    : ts
      ? `import { issueToken } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${loginMeta}export const POST = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  // TODO: look up user in DB and compare password
  res.status(401).json({ error: 'Invalid credentials' });
};
`
      : `import { issueToken } from 'express-file-cluster/auth';
${loginMeta}export const POST = async (req, res) => {
  const { email, password } = req.body;
  // TODO: look up user in DB and compare password
  res.status(401).json({ error: 'Invalid credentials' });
};
`;

  const logoutMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Revoke the current session and clear the auth cookie.',\n    response: { status: 200, body: { message: 'Logged out successfully' } },\n  },\n};\n\n`
      : `export const meta = {\n  POST: {\n    description: 'Revoke the current session and clear the auth cookie.',\n    response: { status: 200, body: { message: 'Logged out successfully' } },\n  },\n};\n\n`
    : '';

  const logoutContent = ts
    ? `import { revokeSession } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${logoutMeta}export const POST = async (req: Request, res: Response) => {
  // Rejects this token from now on (not just the cookie) — see \`cache\` in efc.config.
  await revokeSession(req, res);
  res.clearCookie('efc_refresh_token');
  res.json({ message: 'Logged out successfully' });
};
`
    : `import { revokeSession } from 'express-file-cluster/auth';
${logoutMeta}export const POST = async (req, res) => {
  // Rejects this token from now on (not just the cookie) — see \`cache\` in efc.config.
  await revokeSession(req, res);
  res.clearCookie('efc_refresh_token');
  res.json({ message: 'Logged out successfully' });
};
`;

  await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `login.${ext}`), loginContent);
  await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `logout.${ext}`), logoutContent);

  if (!hasUser) return;

  const registerMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Register a new user account.',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret' } },\n    response: { status: 201, body: { message: 'Account created successfully' } },\n  },\n};\n\n`
      : `export const meta = {\n  POST: {\n    description: 'Register a new user account.',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret' } },\n    response: { status: 201, body: { message: 'Account created successfully' } },\n  },\n};\n\n`
    : '';

  const registerDbImports = `import bcrypt from 'bcrypt';\nimport crypto from 'node:crypto';\n${sendsMail(opts) ? "import { enqueue } from 'express-file-cluster/tasks';\n" : ''}import { User } from '../../model/User.js';\n`;

  const sendVerifyEmail = sendsMail(opts)
    ? `
  var appUrl = process.env.APP_URL || 'http://localhost:3000';
  await enqueue('SendEmail', {
    to: email,
    subject: 'Verify your email address',
    body: 'Welcome, ' + name + '! Verify your email: ' + appUrl + '/auth/verify-email?token=' + verifyToken,
  });
`
    : `
  // TODO: email this token to the user — enable the Mailer feature to auto-wire SendEmail
`;

  const registerContent = ts
    ? `import type { Request, Response } from 'express';
${registerDbImports}${registerMeta}export const POST = async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const existing = await ${db.findOne('User', `{ email }`)};
  if (existing) return res.status(409).json({ error: 'Email already in use' });
  const hashed = await bcrypt.hash(password, 10);
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const user = await ${db.create('User', `{ name, email, password: hashed, verifyToken }`)};
${sendVerifyEmail}
  const { password: _, verifyToken: __, ...safe } = user;
  res.status(201).json({ message: 'Account created successfully', user: safe });
};
`
    : `${registerDbImports}${registerMeta}export const POST = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const existing = await ${db.findOne('User', `{ email }`)};
  if (existing) return res.status(409).json({ error: 'Email already in use' });
  const hashed = await bcrypt.hash(password, 10);
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const user = await ${db.create('User', `{ name, email, password: hashed, verifyToken }`)};
${sendVerifyEmail}
  const { password: _, verifyToken: __, ...safe } = user;
  res.status(201).json({ message: 'Account created successfully', user: safe });
};
`;

  const meMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Return the currently authenticated user.',\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n};\n\n`
      : `export const meta = {\n  GET: {\n    description: 'Return the currently authenticated user.',\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n};\n\n`
    : '';
  const meMiddlewares = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n\n`
    : `export const middlewares = [requireAuth];\n\n`;

  const meContent = ts
    ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${meMeta}${meMiddlewares}export const GET = async (req: Request, res: Response) => {
  res.json({ user: (req as any).user });
};
`
    : `import { requireAuth } from 'express-file-cluster/auth';
${meMeta}${meMiddlewares}export const GET = async (req, res) => {
  res.json({ user: req.user });
};
`;

  await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `register.${ext}`), registerContent);
  await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `me.${ext}`), meContent);
}

async function writeAdminRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const db = orm(opts);
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  const middlewares = opts.rbac
    ? `export const middlewares = [requireAuth('admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const roleGuard = opts.rbac
    ? ''
    : ts
      ? `  const user = (req as any).user;\n  if (user?.role !== 'admin') {\n    return res.status(403).json({ error: 'Forbidden: Admin access required' });\n  }\n\n`
      : `  const user = req.user;\n  if (user?.role !== 'admin') {\n    return res.status(403).json({ error: 'Forbidden: Admin access required' });\n  }\n\n`;

  const dashboardMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Admin dashboard stats. Requires admin role.',\n    response: { status: 200, body: { stats: { totalUsers: 120, activeUsers: 98, verifiedUsers: 84 } } },\n  },\n};\n\n`
      : `export const meta = {\n  GET: {\n    description: 'Admin dashboard stats. Requires admin role.',\n    response: { status: 200, body: { stats: { totalUsers: 120, activeUsers: 98, verifiedUsers: 84 } } },\n  },\n};\n\n`
    : '';

  // Real stats need the User model, which only exists when userManagement is on (registry
  // mode: always — auth brings it).
  const dashboardHasUserModel = !!opts.registry || opts.adminFeatures.userManagement;

  const dashboardDbImport = dashboardHasUserModel
    ? `import { User } from '../../model/User.js';\n`
    : '';

  const dashboardContent = dashboardHasUserModel
    ? ts
      ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${dashboardDbImport}${dashboardMeta}${middlewares}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  const [totalUsers, activeUsers, verifiedUsers] = await Promise.all([
    ${db.count('User', `{}`)},
    ${db.count('User', `{ isActive: true }`)},
    ${db.count('User', `{ isVerified: true }`)},
  ]);
  res.json({ stats: { totalUsers, activeUsers, verifiedUsers } });
};
`
      : `import { requireAuth } from 'express-file-cluster/auth';
${dashboardDbImport}${dashboardMeta}${middlewares}
export const GET = async (_req, res) => {
${roleGuard}  const [totalUsers, activeUsers, verifiedUsers] = await Promise.all([
    ${db.count('User', `{}`)},
    ${db.count('User', `{ isActive: true }`)},
    ${db.count('User', `{ isVerified: true }`)},
  ]);
  res.json({ stats: { totalUsers, activeUsers, verifiedUsers } });
};
`
    : ts
      ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${dashboardMeta}${middlewares}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: aggregate stats from DB
  res.json({ stats: { users: 0 } });
};
`
      : `import { requireAuth } from 'express-file-cluster/auth';
${dashboardMeta}${middlewares}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: aggregate stats from DB
  res.json({ stats: { users: 0 } });
};
`;

  await fs.outputFile(path.join(dest, 'src', 'api', 'admin', `dashboard.${ext}`), dashboardContent);

  if (!opts.adminFeatures.userManagement) return;

  // Admin user management routes
  const usersListMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'List all users, paginated (admin only).',\n    request: { query: { page: '1', limit: '20' } },\n    response: { status: 200, body: { users: [], total: 0, page: 1, limit: 20 } },\n  },\n  POST: {\n    description: 'Create a new user account (admin only).',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret', role: 'user' } },\n    response: { status: 201, body: { message: 'User created', user: { id: 'new-id', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n};\n\n`
      : `export const meta = {\n  GET: {\n    description: 'List all users, paginated (admin only).',\n    request: { query: { page: '1', limit: '20' } },\n    response: { status: 200, body: { users: [], total: 0, page: 1, limit: 20 } },\n  },\n  POST: {\n    description: 'Create a new user account (admin only).',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret', role: 'user' } },\n    response: { status: 201, body: { message: 'User created', user: { id: 'new-id', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n};\n\n`
    : '';

  const adminUsersDbImport = ts
    ? `import bcrypt from 'bcrypt';\nimport { User } from '../../../model/User.js';\n`
    : `import bcrypt from 'bcrypt';\nimport { User } from '../../../model/User.js';\n`;

  const usersListContent = ts
    ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${adminUsersDbImport}${usersListMeta}${middlewares}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const [all, total] = await Promise.all([${db.find('User', `{}`)}, ${db.count('User', `{}`)}]);
  const users = all.slice((page - 1) * limit, page * limit).map(({ password: _, ...u }) => u);
  res.json({ users, total, page, limit });
};

export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  const existing = await ${db.findOne('User', `{ email }`)};
  if (existing) return res.status(409).json({ error: 'Email already in use' });
  const hashed = await bcrypt.hash(password, 10);
  const user = await ${db.create('User', `{ name, email, password: hashed, role: role ?? 'user' }`)};
  const { password: _, ...safe } = user;
  res.status(201).json({ message: 'User created', user: safe });
};
`
    : `import { requireAuth } from 'express-file-cluster/auth';
${adminUsersDbImport}${usersListMeta}${middlewares}
export const GET = async (req, res) => {
${roleGuard}  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const [all, total] = await Promise.all([${db.find('User', `{}`)}, ${db.count('User', `{}`)}]);
  const users = all.slice((page - 1) * limit, page * limit).map(({ password: _, ...u }) => u);
  res.json({ users, total, page, limit });
};

export const POST = async (req, res) => {
${roleGuard}  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  const existing = await ${db.findOne('User', `{ email }`)};
  if (existing) return res.status(409).json({ error: 'Email already in use' });
  const hashed = await bcrypt.hash(password, 10);
  const user = await ${db.create('User', `{ name, email, password: hashed, role: role ?? 'user' }`)};
  const { password: _, ...safe } = user;
  res.status(201).json({ message: 'User created', user: safe });
};
`;

  await fs.outputFile(
    path.join(dest, 'src', 'api', 'admin', 'users', `index.${ext}`),
    usersListContent,
  );

  const userByIdMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Fetch a single user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  PUT: {\n    description: 'Update a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' }, body: { name: 'Jane Doe', email: 'jane@example.com', role: 'user', isActive: true } },\n    response: { status: 200, body: { message: 'User updated', user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  DELETE: {\n    description: 'Delete a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { message: 'User usr_01HXZ deleted' } },\n  },\n};\n\n`
      : `export const meta = {\n  GET: {\n    description: 'Fetch a single user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  PUT: {\n    description: 'Update a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' }, body: { name: 'Jane Doe', email: 'jane@example.com', role: 'user', isActive: true } },\n    response: { status: 200, body: { message: 'User updated', user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  DELETE: {\n    description: 'Delete a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { message: 'User usr_01HXZ deleted' } },\n  },\n};\n\n`
    : '';

  const adminUserByIdDbImport = `import { User } from '../../../model/User.js';\n`;

  const userByIdContent = ts
    ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${adminUserByIdDbImport}${userByIdMeta}${middlewares}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
};

export const PUT = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  const { name, email, role, isActive } = req.body;
  const updated = await ${db.update('User', `id`, `{ name, email, role, isActive }`)};
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = updated;
  res.json({ message: 'User updated', user: safe });
};

export const DELETE = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  await ${db.delete('User', `id`)};
  res.json({ message: \`User \${id} deleted\` });
};
`
    : `import { requireAuth } from 'express-file-cluster/auth';
${adminUserByIdDbImport}${userByIdMeta}${middlewares}
export const GET = async (req, res) => {
${roleGuard}  const { id } = req.params;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
};

export const PUT = async (req, res) => {
${roleGuard}  const { id } = req.params;
  const { name, email, role, isActive } = req.body;
  const updated = await ${db.update('User', `id`, `{ name, email, role, isActive }`)};
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = updated;
  res.json({ message: 'User updated', user: safe });
};

export const DELETE = async (req, res) => {
${roleGuard}  const { id } = req.params;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  await ${db.delete('User', `id`)};
  res.json({ message: \`User \${id} deleted\` });
};
`;

  await fs.outputFile(
    path.join(dest, 'src', 'api', 'admin', 'users', `[id].${ext}`),
    userByIdContent,
  );
}

async function writeUserRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const db = orm(opts);
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  const middlewares = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n`
    : `export const middlewares = [requireAuth];\n`;

  const profileMeta = opts.routeDocs
    ? ts
      ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: "Fetch the authenticated user's profile.",\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n  PUT: {\n    description: "Update the authenticated user's profile.",\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com' } },\n    response: { status: 200, body: { message: 'Profile updated', user: { id: '1', role: 'user', email: 'jane@example.com' } } },\n  },\n};\n\n`
      : `export const meta = {\n  GET: {\n    description: "Fetch the authenticated user's profile.",\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n  PUT: {\n    description: "Update the authenticated user's profile.",\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com' } },\n    response: { status: 200, body: { message: 'Profile updated', user: { id: '1', role: 'user', email: 'jane@example.com' } } },\n  },\n};\n\n`
    : '';

  const profileDbImport = `import { User } from '../../model/User.js';\n`;

  const profileContent = ts
    ? `import { requireAuth } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
${profileDbImport}${profileMeta}${middlewares}
export const GET = async (req: Request, res: Response) => {
  const { id } = (req as any).user;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
};

export const PUT = async (req: Request, res: Response) => {
  const { id } = (req as any).user;
  const { name, email } = req.body;
  const updated = await ${db.update('User', `id`, `{ name, email }`)};
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = updated;
  res.json({ message: 'Profile updated', user: safe });
};
`
    : `import { requireAuth } from 'express-file-cluster/auth';
${profileDbImport}${profileMeta}${middlewares}
export const GET = async (req, res) => {
  const { id } = req.user;
  const user = await ${db.findById('User', `id`)};
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
};

export const PUT = async (req, res) => {
  const { id } = req.user;
  const { name, email } = req.body;
  const updated = await ${db.update('User', `id`, `{ name, email }`)};
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safe } = updated;
  res.json({ message: 'Profile updated', user: safe });
};
`;

  await fs.outputFile(path.join(dest, 'src', 'api', 'user', `profile.${ext}`), profileContent);
}

// ─── META HELPER ─────────────────────────────────────────────────────────

interface MethodMetaSpec {
  description: string;
  params?: string;
  query?: string;
  request?: string;
  response?: string;
  status?: number;
}

function mkMeta(opts: ScaffoldOptions, methods: Record<string, MethodMetaSpec>): string {
  if (!opts.routeDocs) return '';
  const blocks = Object.entries(methods)
    .map(([method, m]) => {
      const reqParts: string[] = [];
      if (m.params) reqParts.push(`params: ${m.params}`);
      if (m.query) reqParts.push(`query: ${m.query}`);
      if (m.request) reqParts.push(`body: ${m.request}`);
      const reqLine = reqParts.length ? `      request: { ${reqParts.join(', ')} },\n` : '';
      const status = m.status ?? 200;
      const respLine =
        m.response !== undefined
          ? `      response: { status: ${status}, body: ${m.response} },\n`
          : `      response: { status: ${status} },\n`;
      const description = m.description.replace(/'/g, "\\'");
      return `  ${method}: {\n    description: '${description}',\n${reqLine}${respLine}  },`;
    })
    .join('\n');
  return opts.language === 'typescript'
    ? `import type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n${blocks}\n};\n\n`
    : `export const meta = {\n${blocks}\n};\n\n`;
}

// ─── EXTENDED MODEL WRITERS ───────────────────────────────────────────────

async function writeSessionModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Session = ${modelApi(opts).name}('Session', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:    { type: 'string',  required: true },`, required: true, onDelete: 'cascade' })}
  token:     { type: 'string',  required: true, unique: true },
  ip:        { type: 'string',  required: true },
  userAgent: { type: 'string',  required: true },
  expiresAt: { type: 'date',    required: true },
  isActive:  { type: 'boolean', default: true },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Session.${ext}`), content);
}

async function writeNotificationModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Notification = ${modelApi(opts).name}('Notification', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:  { type: 'string',  required: true },`, required: true, onDelete: 'cascade' })}
  title:   { type: 'string',  required: true },
  message: { type: 'string',  required: true },
  type:    { type: 'string',  required: true, default: 'info' },
  isRead:  { type: 'boolean', default: false },
  link:    { type: 'string' },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Notification.${ext}`), content);
}

async function writeFileModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const File = ${modelApi(opts).name}('File', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:       { type: 'string',  required: true },`, required: true, onDelete: 'cascade' })}
  filename:     { type: 'string',  required: true },
  originalName: { type: 'string',  required: true },
  mimeType:     { type: 'string',  required: true },
  size:         { type: 'number',  required: true },
  url:          { type: 'string',  required: true },
  isPublic:     { type: 'boolean', default: false },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `File.${ext}`), content);
}

async function writeSupportTicketModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const SupportTicket = ${modelApi(opts).name}('SupportTicket', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:     { type: 'string', required: true },`, required: true, onDelete: 'cascade' })}
  subject:    { type: 'string', required: true },
  message:    { type: 'string', required: true },
  status:     { type: 'string', required: true, default: 'open' },
  priority:   { type: 'string', required: true, default: 'normal' },
${refField(opts, { field: 'assignedTo', target: 'Admin', legacy: `  assignedTo: { type: 'string' },`, onDelete: 'setNull' })}
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `SupportTicket.${ext}`), content);
}

async function writeAuditLogModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const AuditLog = ${modelApi(opts).name}('AuditLog', {
${refField(opts, { field: 'admin', target: 'Admin', legacy: `  adminId:  { type: 'string', required: true },`, onDelete: 'setNull' })}
  action:   { type: 'string', required: true },
  entity:   { type: 'string', required: true },
  entityId: { type: 'string', required: true },
  metadata: { type: 'object' },
  ip:       { type: 'string', required: true },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `AuditLog.${ext}`), content);
}

async function writeSubscriptionModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Subscription = ${modelApi(opts).name}('Subscription', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:      { type: 'string', required: true },`, required: true, onDelete: 'cascade' })}
${refField(opts, { field: 'plan', target: 'Plan', legacy: `  planId:      { type: 'string', required: true },`, required: true, onDelete: 'restrict' })}
  status:      { type: 'string', required: true, default: 'active' },
  startDate:   { type: 'date',   required: true },
  endDate:     { type: 'date',   required: true },
  cancelledAt: { type: 'date' },
}${relationsOption(opts, [{ name: 'invoices', kind: 'hasMany', target: 'Invoice', foreignKey: 'subscription' }])});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Subscription.${ext}`), content);
}

async function writePlanModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Plan = ${modelApi(opts).name}('Plan', {
  name:        { type: 'string',  required: true },
  description: { type: 'string',  required: true },
  price:       { type: 'number',  required: true },
  interval:    { type: 'string',  required: true, default: 'monthly' },
  features:    { type: 'array',   of: 'string', default: [] },
  isActive:    { type: 'boolean', default: true },
}${relationsOption(opts, [{ name: 'subscriptions', kind: 'hasMany', target: 'Subscription', foreignKey: 'plan' }])});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Plan.${ext}`), content);
}

async function writeInvoiceModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Invoice = ${modelApi(opts).name}('Invoice', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:         { type: 'string', required: true },`, required: true, onDelete: 'cascade' })}
${refField(opts, { field: 'subscription', target: 'Subscription', legacy: `  subscriptionId: { type: 'string', required: true },`, onDelete: 'setNull' })}
  amount:         { type: 'number', required: true },
  currency:       { type: 'string', required: true, default: 'USD' },
  status:         { type: 'string', required: true, default: 'pending' },
  paidAt:         { type: 'date' },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Invoice.${ext}`), content);
}

async function writeApiKeyModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const ApiKey = ${modelApi(opts).name}('ApiKey', {
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:    { type: 'string',  required: true },`, required: true, onDelete: 'cascade' })}
  name:      { type: 'string',  required: true },
  key:       { type: 'string',  required: true, unique: true },
  lastUsed:  { type: 'date' },
  expiresAt: { type: 'date' },
  isActive:  { type: 'boolean', default: true },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `ApiKey.${ext}`), content);
}

async function writeRoleModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Role = ${modelApi(opts).name}('Role', {
  name:        { type: 'string', required: true, unique: true },
  description: { type: 'string', required: true },
  permissions: { type: 'array',  of: 'string', default: [] },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Role.${ext}`), content);
}

async function writeFAQModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const FAQ = ${modelApi(opts).name}('FAQ', {
  question:    { type: 'string',  required: true },
  answer:      { type: 'string',  required: true },
  category:    { type: 'string',  required: true, default: 'general' },
  order:       { type: 'number',  default: 0 },
  isPublished: { type: 'boolean', default: false },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `FAQ.${ext}`), content);
}

async function writeBlogModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Blog = ${modelApi(opts).name}('Blog', {
  title:       { type: 'string', required: true },
  slug:        { type: 'string', required: true, unique: true },
  content:     { type: 'string', required: true },
${refField(opts, { field: 'author', target: 'Admin', legacy: `  authorId:    { type: 'string', required: true },`, onDelete: 'setNull' })}
  category:    { type: 'string', required: true, default: 'general' },
  tags:        { type: 'array',  of: 'string', default: [] },
  status:      { type: 'string', required: true, default: 'draft' },
  publishedAt: { type: 'date' },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Blog.${ext}`), content);
}

async function writeCategoryModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Category = ${modelApi(opts).name}('Category', {
  name:        { type: 'string', required: true },
  slug:        { type: 'string', required: true, unique: true },
  description: { type: 'string' },
${refField(opts, { field: 'parent', target: 'Category', legacy: `  parentId:    { type: 'string' },`, onDelete: 'setNull' })}
}${relationsOption(opts, [{ name: 'children', kind: 'hasMany', target: 'Category', foreignKey: 'parent' }])});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Category.${ext}`), content);
}

async function writeCouponModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

export const Coupon = ${modelApi(opts).name}('Coupon', {
  code:      { type: 'string',  required: true, unique: true },
  type:      { type: 'string',  required: true, default: 'percent' },
  value:     { type: 'number',  required: true },
  maxUses:   { type: 'number',  default: 0 },
  usedCount: { type: 'number',  default: 0 },
  expiresAt: { type: 'date' },
  isActive:  { type: 'boolean', default: true },
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `Coupon.${ext}`), content);
}

// ─── EXTENDED ROUTE WRITERS ───────────────────────────────────────────────

async function writeAuthExtendedRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const db = orm(opts);
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  const mwUser2 = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const mwUser3 = mwUser2;
  const RA = `import { requireAuth } from 'express-file-cluster/auth';\n`;
  const hasAdmin = principals(opts).admin;
  const uf = opts.userFeatures;
  const sendResetEmail = sendsMail(opts)
    ? `    var appUrl = process.env.APP_URL || 'http://localhost:3000';
    await enqueue('SendEmail', {
      to: email,
      subject: 'Reset your password',
      body: 'Reset your password: ' + appUrl + '/auth/reset-password?token=' + resetToken,
    });
`
    : `    // TODO: email this token to the user — enable the Mailer feature to auto-wire SendEmail
`;
  const sendVerifyEmailResend = sendsMail(opts)
    ? `    var appUrl = process.env.APP_URL || 'http://localhost:3000';
    await enqueue('SendEmail', {
      to: email,
      subject: 'Verify your email address',
      body: 'Verify your email: ' + appUrl + '/auth/verify-email?token=' + verifyToken,
    });
`
    : `    // TODO: email this token to the user — enable the Mailer feature to auto-wire SendEmail
`;
  const mailerTaskImport = sendsMail(opts)
    ? `import { enqueue } from 'express-file-cluster/tasks';\n`
    : '';

  // refresh.ts
  if (uf.accountSecurity) {
    const refreshMeta = mkMeta(opts, {
      POST: {
        description: 'Refresh the JWT using the refresh-token cookie and issue a new access token.',
        response: `{ message: 'Token refreshed' }`,
      },
    });
    const refreshModelImports = `import { User } from '../../model/User.js';\n${hasAdmin ? `import { Admin } from '../../model/Admin.js';\n` : ''}`;
    const refreshLookup = hasAdmin
      ? `  const user = await ${db.findOne('User', `{ refreshToken: token }`)};
  const admin = user ? null : await ${db.findOne('Admin', `{ refreshToken: token }`)};
  const account = user || admin;`
      : `  const user = await ${db.findOne('User', `{ refreshToken: token }`)};
  const account = user;`;
    const refreshPersist = hasAdmin
      ? `  if (user) await ${db.update('User', `user.id`, `{ refreshToken: newRefreshToken, refreshTokenExpiry }`)};
  else if (admin) await ${db.update('Admin', `admin.id`, `{ refreshToken: newRefreshToken, refreshTokenExpiry }`)};`
      : `  await ${db.update('User', `user.id`, `{ refreshToken: newRefreshToken, refreshTokenExpiry }`)};`;
    const refreshContent = ts
      ? `import { issueToken } from 'express-file-cluster/auth';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
${refreshModelImports}${refreshMeta}const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const POST = async (req: Request, res: Response) => {
  const token = req.cookies?.['efc_refresh_token'] || req.body?.refreshToken;
  if (!token) return res.status(401).json({ error: 'Refresh token required' });

${refreshLookup}

  if (!account || !account.refreshTokenExpiry || new Date(account.refreshTokenExpiry) < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const newRefreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenExpiry = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
${refreshPersist}

  res.cookie('efc_refresh_token', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  await issueToken(res, { id: account.id, role: account.role, email: account.email });
  res.json({ message: 'Token refreshed' });
};
`
      : `import { issueToken } from 'express-file-cluster/auth';
import crypto from 'node:crypto';
${refreshModelImports}${refreshMeta}const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const POST = async (req, res) => {
  const token = req.cookies?.efc_refresh_token || req.body?.refreshToken;
  if (!token) return res.status(401).json({ error: 'Refresh token required' });

${refreshLookup}

  if (!account || !account.refreshTokenExpiry || new Date(account.refreshTokenExpiry) < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const newRefreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenExpiry = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
${refreshPersist}

  res.cookie('efc_refresh_token', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  await issueToken(res, { id: account.id, role: account.role, email: account.email });
  res.json({ message: 'Token refreshed' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `refresh.${ext}`), refreshContent);
  }

  // verify-email.ts
  if (uf.emailVerification) {
    const veMeta = mkMeta(opts, {
      GET: {
        description: 'Verify an email address using the token from the verification link.',
        query: `{ token: 'a1b2c3d4' }`,
        response: `{ message: 'Email verified' }`,
      },
      POST: {
        description: 'Resend the verification email to a given address.',
        request: `{ email: 'user@example.com' }`,
        response: `{ message: 'Verification email sent' }`,
      },
    });
    const veContent = ts
      ? `import type { Request, Response } from 'express';
import crypto from 'node:crypto';
${mailerTaskImport}import { User } from '../../model/User.js';
${veMeta}export const GET = async (req: Request, res: Response) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });

  const user = await ${db.findOne('User', `{ verifyToken: token }`)};
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });

  await ${db.update('User', `user.id`, `{ isVerified: true, verifyToken: '' }`)};
  res.json({ message: 'Email verified' });
};

export const POST = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await ${db.findOne('User', `{ email }`)};
  if (user && !user.isVerified) {
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await ${db.update('User', `user.id`, `{ verifyToken }`)};
${sendVerifyEmailResend}  }

  res.json({ message: 'Verification email sent' });
};
`
      : `import crypto from 'node:crypto';
${mailerTaskImport}import { User } from '../../model/User.js';
${veMeta}export const GET = async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });

  const user = await ${db.findOne('User', `{ verifyToken: token }`)};
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });

  await ${db.update('User', `user.id`, `{ isVerified: true, verifyToken: '' }`)};
  res.json({ message: 'Email verified' });
};

export const POST = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await ${db.findOne('User', `{ email }`)};
  if (user && !user.isVerified) {
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await ${db.update('User', `user.id`, `{ verifyToken }`)};
${sendVerifyEmailResend}  }

  res.json({ message: 'Verification email sent' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `verify-email.${ext}`), veContent);
  }

  // forgot-password.ts / reset-password.ts
  if (uf.forgotPassword) {
    const fpMeta = mkMeta(opts, {
      POST: {
        description: 'Send a password reset email to the given address.',
        request: `{ email: 'user@example.com' }`,
        response: `{ message: 'Reset email sent' }`,
      },
    });
    const fpModelImports = `import { User } from '../../model/User.js';\n${hasAdmin ? `import { Admin } from '../../model/Admin.js';\n` : ''}`;
    const fpLookup = hasAdmin
      ? `  const user = await ${db.findOne('User', `{ email }`)};
  const admin = user ? null : await ${db.findOne('Admin', `{ email }`)};`
      : `  const user = await ${db.findOne('User', `{ email }`)};`;
    const fpGuard = hasAdmin ? 'user || admin' : 'user';
    const fpPersist = hasAdmin
      ? `    if (user) await ${db.update('User', `user.id`, `{ resetToken, resetTokenExpiry }`)};
    else if (admin) await ${db.update('Admin', `admin.id`, `{ resetToken, resetTokenExpiry }`)};`
      : `    await ${db.update('User', `user.id`, `{ resetToken, resetTokenExpiry }`)};`;
    const fpContent = ts
      ? `import type { Request, Response } from 'express';
import crypto from 'node:crypto';
${mailerTaskImport}${fpModelImports}${fpMeta}const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

export const POST = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

${fpLookup}

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to enumerate registered emails.
  if (${fpGuard}) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);
${fpPersist}
${sendResetEmail}  }

  res.json({ message: 'Reset email sent' });
};
`
      : `import crypto from 'node:crypto';
${mailerTaskImport}${fpModelImports}${fpMeta}const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

export const POST = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

${fpLookup}

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to enumerate registered emails.
  if (${fpGuard}) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);
${fpPersist}
${sendResetEmail}  }

  res.json({ message: 'Reset email sent' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `forgot-password.${ext}`), fpContent);

    // reset-password.ts
    const rpMeta = mkMeta(opts, {
      POST: {
        description: 'Reset password using a valid reset token.',
        request: `{ token: 'reset-token', password: 'newpassword' }`,
        response: `{ message: 'Password reset successfully' }`,
      },
    });
    const rpModelImports = `import { User } from '../../model/User.js';\n${hasAdmin ? `import { Admin } from '../../model/Admin.js';\n` : ''}`;
    const rpLookup = hasAdmin
      ? `  const user = await ${db.findOne('User', `{ resetToken: token }`)};
  const admin = user ? null : await ${db.findOne('Admin', `{ resetToken: token }`)};
  const account = user || admin;`
      : `  const user = await ${db.findOne('User', `{ resetToken: token }`)};
  const account = user;`;
    const rpPersist = hasAdmin
      ? `  if (user) await ${db.update('User', `user.id`, `{ password: hashed, resetToken: '' }`)};
  else if (admin) await ${db.update('Admin', `admin.id`, `{ password: hashed, resetToken: '' }`)};`
      : `  await ${db.update('User', `user.id`, `{ password: hashed, resetToken: '' }`)};`;
    const rpContent = ts
      ? `import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { revokeAllSessions } from 'express-file-cluster/auth';
${rpModelImports}${rpMeta}export const POST = async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });

${rpLookup}

  if (!account || !account.resetTokenExpiry || new Date(account.resetTokenExpiry) < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const hashed = await bcrypt.hash(password, 10);
${rpPersist}
  // Tokens issued with the old password stop working everywhere.
  await revokeAllSessions(account.id);

  res.json({ message: 'Password reset successfully' });
};
`
      : `import bcrypt from 'bcrypt';
import { revokeAllSessions } from 'express-file-cluster/auth';
${rpModelImports}${rpMeta}export const POST = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });

${rpLookup}

  if (!account || !account.resetTokenExpiry || new Date(account.resetTokenExpiry) < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const hashed = await bcrypt.hash(password, 10);
${rpPersist}
  // Tokens issued with the old password stop working everywhere.
  await revokeAllSessions(account.id);

  res.json({ message: 'Password reset successfully' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `reset-password.${ext}`), rpContent);
  }

  // change-password.ts (protected)
  if (uf.accountSecurity) {
    const cpMeta = mkMeta(opts, {
      POST: {
        description: 'Change password for the authenticated user.',
        request: `{ oldPassword: 'current', newPassword: 'newpassword' }`,
        response: `{ message: 'Password changed successfully' }`,
      },
    });
    const cpContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${cpMeta}${mwUser2}
export const POST = async (req: Request, res: Response) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword are required' });
  // TODO: verify old password, hash and update new password, then sign out other devices:
  // await revokeAllSessions(req.user.id)  (import from 'express-file-cluster/auth')
  res.json({ message: 'Password changed successfully' });
};
`
      : `${RA}${cpMeta}${mwUser2}
export const POST = async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword are required' });
  // TODO: verify old password, hash and update new password, then sign out other devices:
  // await revokeAllSessions(req.user.id)  (import from 'express-file-cluster/auth')
  res.json({ message: 'Password changed successfully' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', `change-password.${ext}`), cpContent);

    // 2fa/setup.ts
    const tfaSetupMeta = mkMeta(opts, {
      GET: {
        description: 'Generate a TOTP secret and QR code to set up 2FA.',
        response: `{ qrCode: 'otpauth://totp/...', secret: 'BASE32SECRET' }`,
      },
      POST: {
        description: 'Confirm a TOTP code to enable 2FA for the authenticated user.',
        request: `{ code: '123456' }`,
        response: `{ message: '2FA enabled' }`,
      },
    });
    const tfaSetupContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${tfaSetupMeta}${mwUser3}
export const GET = async (req: Request, res: Response) => {
  // TODO: generate TOTP secret and return QR code URL
  res.json({ qrCode: 'otpauth://totp/...', secret: 'BASE32SECRET' });
};

export const POST = async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify TOTP code and enable 2FA
  res.json({ message: '2FA enabled' });
};
`
      : `${RA}${tfaSetupMeta}${mwUser3}
export const GET = async (req, res) => {
  // TODO: generate TOTP secret and return QR code URL
  res.json({ qrCode: 'otpauth://totp/...', secret: 'BASE32SECRET' });
};

export const POST = async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify TOTP code and enable 2FA
  res.json({ message: '2FA enabled' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', '2fa', `setup.${ext}`),
      tfaSetupContent,
    );

    // 2fa/verify.ts
    const tfaVerifyMeta = mkMeta(opts, {
      POST: {
        description: 'Verify a TOTP code during login.',
        request: `{ code: '123456' }`,
        response: `{ message: '2FA verified' }`,
      },
    });
    const tfaVerifyContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${tfaVerifyMeta}export const POST = async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify TOTP code
  res.json({ message: '2FA verified' });
};
`
      : `${RA}${tfaVerifyMeta}export const POST = async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify TOTP code
  res.json({ message: '2FA verified' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', '2fa', `verify.${ext}`),
      tfaVerifyContent,
    );

    // 2fa/disable.ts
    const tfaDisableMeta = mkMeta(opts, {
      POST: {
        description: 'Disable 2FA for the authenticated user.',
        request: `{ code: '123456' }`,
        response: `{ message: '2FA disabled' }`,
      },
    });
    const tfaDisableContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${tfaDisableMeta}${mwUser3}
export const POST = async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify code and disable 2FA
  res.json({ message: '2FA disabled' });
};
`
      : `${RA}${tfaDisableMeta}${mwUser3}
export const POST = async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  // TODO: verify code and disable 2FA
  res.json({ message: '2FA disabled' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', '2fa', `disable.${ext}`),
      tfaDisableContent,
    );

    // sessions/index.ts
    const sessListMeta = mkMeta(opts, {
      GET: {
        description: 'List all active sessions for the authenticated user.',
        response: `{ sessions: [] }`,
      },
    });
    const sessListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${sessListMeta}${mwUser3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch sessions for req.user.id
  res.json({ sessions: [] });
};
`
      : `${RA}${sessListMeta}${mwUser3}
export const GET = async (req, res) => {
  // TODO: fetch sessions for req.user.id
  res.json({ sessions: [] });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', 'sessions', `index.${ext}`),
      sessListContent,
    );

    // sessions/[id].ts
    const sessRevokeMeta = mkMeta(opts, {
      DELETE: {
        description: 'Revoke a single active session by ID.',
        params: `{ id: 'sess_01HXZ' }`,
        response: `{ message: 'Session sess_01HXZ revoked' }`,
      },
    });
    const sessRevokeContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${sessRevokeMeta}${mwUser3}
export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: revoke session by id
  res.json({ message: \`Session \${id} revoked\` });
};
`
      : `${RA}${sessRevokeMeta}${mwUser3}
export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: revoke session by id
  res.json({ message: \`Session \${id} revoked\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', 'sessions', `[id].${ext}`),
      sessRevokeContent,
    );
  }
}

async function writeUserExtendedRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  // user/* = 2 levels up to src/, user/subdir/* = 3 levels
  const mw2 = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const mw3 = mw2;
  const RA = `import { requireAuth } from 'express-file-cluster/auth';\n`;
  const user = ts ? `(req as any).user` : `req.user`;
  const uf = opts.userFeatures;

  // avatar.ts
  if (uf.accountSettings) {
    const avatarMeta = mkMeta(opts, {
      POST: {
        description: 'Upload a new avatar image for the authenticated user.',
        response: `{ message: 'Avatar updated', url: 'https://example.com/avatar.jpg' }`,
      },
      DELETE: {
        description: "Remove the authenticated user's avatar.",
        response: `{ message: 'Avatar removed' }`,
      },
    });
    const avatarContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${avatarMeta}${mw2}
export const POST = async (req: Request, res: Response) => {
  // TODO: handle multipart upload, store file, update user.avatar
  res.json({ message: 'Avatar updated', url: 'https://example.com/avatar.jpg' });
};

export const DELETE = async (req: Request, res: Response) => {
  // TODO: remove avatar and clear user.avatar
  res.json({ message: 'Avatar removed' });
};
`
      : `${RA}${avatarMeta}${mw2}
export const POST = async (req, res) => {
  // TODO: handle multipart upload, store file, update user.avatar
  res.json({ message: 'Avatar updated', url: 'https://example.com/avatar.jpg' });
};

export const DELETE = async (req, res) => {
  // TODO: remove avatar and clear user.avatar
  res.json({ message: 'Avatar removed' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `avatar.${ext}`), avatarContent);

    // settings.ts
    const settingsMeta = mkMeta(opts, {
      GET: {
        description:
          'Get account settings (notifications, language, theme, privacy) for the authenticated user.',
        response: `{ settings: { notifications: true, language: 'en', theme: 'system', privacy: 'public' } }`,
      },
      PUT: {
        description: 'Update account settings for the authenticated user.',
        request: `{ notifications: true, language: 'en', theme: 'system', privacy: 'public' }`,
        response: `{ message: 'Settings updated', settings: { notifications: true, language: 'en', theme: 'system', privacy: 'public' } }`,
      },
    });
    const settingsContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${settingsMeta}${mw2}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch user settings from DB
  res.json({ settings: { notifications: true, language: 'en', theme: 'system', privacy: 'public' } });
};

export const PUT = async (req: Request, res: Response) => {
  const { notifications, language, theme, privacy } = req.body;
  // TODO: update user settings in DB
  res.json({ message: 'Settings updated', settings: { notifications, language, theme, privacy } });
};
`
      : `${RA}${settingsMeta}${mw2}
export const GET = async (req, res) => {
  // TODO: fetch user settings from DB
  res.json({ settings: { notifications: true, language: 'en', theme: 'system', privacy: 'public' } });
};

export const PUT = async (req, res) => {
  const { notifications, language, theme, privacy } = req.body;
  // TODO: update user settings in DB
  res.json({ message: 'Settings updated', settings: { notifications, language, theme, privacy } });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `settings.${ext}`), settingsContent);

    // account.ts
    const accountMeta = mkMeta(opts, {
      GET: {
        description: 'Download a personal data export for the authenticated user.',
        response: `{ data: { user: { id: '1', role: 'user', email: 'user@example.com' }, exportedAt: '2026-01-01T00:00:00.000Z' } }`,
      },
      DELETE: {
        description:
          'Schedule the authenticated account for deletion (requires password confirmation).',
        request: `{ password: 'current' }`,
        response: `{ message: 'Account scheduled for deletion' }`,
      },
    });
    const accountContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${accountMeta}${mw2}
export const GET = async (req: Request, res: Response) => {
  // TODO: compile and return personal data export
  res.json({ data: { user: ${user}, exportedAt: new Date().toISOString() } });
};

export const DELETE = async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password confirmation required' });
  // TODO: verify password, schedule account deletion
  res.json({ message: 'Account scheduled for deletion' });
};
`
      : `${RA}${accountMeta}${mw2}
export const GET = async (req, res) => {
  // TODO: compile and return personal data export
  res.json({ data: { user: ${user}, exportedAt: new Date().toISOString() } });
};

export const DELETE = async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password confirmation required' });
  // TODO: verify password, schedule account deletion
  res.json({ message: 'Account scheduled for deletion' });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `account.${ext}`), accountContent);

    // dashboard.ts
    const dashMeta = mkMeta(opts, {
      GET: {
        description: 'Personal dashboard: stats, recent activity, and quick actions.',
        response: `{ stats: {}, recentActivity: [], quickActions: [] }`,
      },
    });
    const dashContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${dashMeta}${mw2}
export const GET = async (req: Request, res: Response) => {
  // TODO: aggregate personal stats and activity
  res.json({ stats: {}, recentActivity: [], quickActions: [] });
};
`
      : `${RA}${dashMeta}${mw2}
export const GET = async (req, res) => {
  // TODO: aggregate personal stats and activity
  res.json({ stats: {}, recentActivity: [], quickActions: [] });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `dashboard.${ext}`), dashContent);

    // activity.ts
    const actMeta = mkMeta(opts, {
      GET: {
        description: 'Paginated activity history for the authenticated user.',
        query: `{ page: '1', limit: '20' }`,
        response: `{ activities: [], total: 0, page: 1, limit: 20 }`,
      },
    });
    const actContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${actMeta}${mw2}
export const GET = async (req: Request, res: Response) => {
  const { page = 1, limit = 20 } = req.query;
  // TODO: fetch paginated activity log
  res.json({ activities: [], total: 0, page: Number(page), limit: Number(limit) });
};
`
      : `${RA}${actMeta}${mw2}
export const GET = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  // TODO: fetch paginated activity log
  res.json({ activities: [], total: 0, page: Number(page), limit: Number(limit) });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `activity.${ext}`), actContent);
  }

  // notifications/index.ts
  if (uf.notifications) {
    const notifListMeta = mkMeta(opts, {
      GET: {
        description: 'List notifications for the authenticated user.',
        response: `{ notifications: [], total: 0, unread: 0 }`,
      },
      POST: {
        description: 'Mark all notifications as read for the authenticated user.',
        response: `{ message: 'All notifications marked as read' }`,
      },
    });
    const notifListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${notifListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch notifications for user
  res.json({ notifications: [], total: 0, unread: 0 });
};

export const POST = async (req: Request, res: Response) => {
  // TODO: mark all notifications as read
  res.json({ message: 'All notifications marked as read' });
};
`
      : `${RA}${notifListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch notifications for user
  res.json({ notifications: [], total: 0, unread: 0 });
};

export const POST = async (req, res) => {
  // TODO: mark all notifications as read
  res.json({ message: 'All notifications marked as read' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'notifications', `index.${ext}`),
      notifListContent,
    );

    // notifications/[id].ts
    const notifByIdMeta = mkMeta(opts, {
      GET: {
        description: 'Fetch a single notification by ID.',
        params: `{ id: 'notif_01HXZ' }`,
        response: `{ notification: { id: 'notif_01HXZ' } }`,
      },
      PATCH: {
        description: 'Mark a single notification as read.',
        params: `{ id: 'notif_01HXZ' }`,
        response: `{ message: 'Notification marked as read', id: 'notif_01HXZ' }`,
      },
      DELETE: {
        description: 'Delete a single notification.',
        params: `{ id: 'notif_01HXZ' }`,
        response: `{ message: 'Notification notif_01HXZ deleted' }`,
      },
    });
    const notifByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${notifByIdMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: fetch notification by id
  res.json({ notification: { id } });
};

export const PATCH = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: mark notification as read
  res.json({ message: 'Notification marked as read', id });
};

export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: delete notification
  res.json({ message: \`Notification \${id} deleted\` });
};
`
      : `${RA}${notifByIdMeta}${mw3}
export const GET = async (req, res) => {
  const { id } = req.params;
  // TODO: fetch notification by id
  res.json({ notification: { id } });
};

export const PATCH = async (req, res) => {
  const { id } = req.params;
  // TODO: mark notification as read
  res.json({ message: 'Notification marked as read', id });
};

export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: delete notification
  res.json({ message: \`Notification \${id} deleted\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'notifications', `[id].${ext}`),
      notifByIdContent,
    );
  }

  // files/index.ts (files, favorites, bookmarks & search share the filesAndMedia toggle)
  if (uf.filesAndMedia) {
    const filesListMeta = mkMeta(opts, {
      GET: {
        description: 'List uploaded files with storage usage for the authenticated user.',
        response: `{ files: [], total: 0, storageUsed: 0 }`,
      },
      POST: {
        description: 'Upload a new file for the authenticated user.',
        response: `{ message: 'File uploaded', file: { id: 'new-id' } }`,
        status: 201,
      },
    });
    const filesListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${filesListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch user files and compute storage usage
  res.json({ files: [], total: 0, storageUsed: 0 });
};

export const POST = async (req: Request, res: Response) => {
  // TODO: handle multipart upload, persist file record
  res.status(201).json({ message: 'File uploaded', file: { id: 'new-id' } });
};
`
      : `${RA}${filesListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch user files and compute storage usage
  res.json({ files: [], total: 0, storageUsed: 0 });
};

export const POST = async (req, res) => {
  // TODO: handle multipart upload, persist file record
  res.status(201).json({ message: 'File uploaded', file: { id: 'new-id' } });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'files', `index.${ext}`),
      filesListContent,
    );

    // files/[id].ts
    const fileByIdMeta = mkMeta(opts, {
      GET: {
        description: 'Get a download/preview URL for a single file by ID.',
        params: `{ id: 'file_01HXZ' }`,
        response: `{ file: { id: 'file_01HXZ', url: 'https://example.com/files/file_01HXZ' } }`,
      },
      DELETE: {
        description: 'Delete a file from storage.',
        params: `{ id: 'file_01HXZ' }`,
        response: `{ message: 'File file_01HXZ deleted' }`,
      },
    });
    const fileByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${fileByIdMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: stream or redirect to file download/preview URL
  res.json({ file: { id, url: 'https://...' } });
};

export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: delete file from storage and DB
  res.json({ message: \`File \${id} deleted\` });
};
`
      : `${RA}${fileByIdMeta}${mw3}
export const GET = async (req, res) => {
  const { id } = req.params;
  // TODO: stream or redirect to file download/preview URL
  res.json({ file: { id, url: 'https://...' } });
};

export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: delete file from storage and DB
  res.json({ message: \`File \${id} deleted\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'files', `[id].${ext}`),
      fileByIdContent,
    );

    // favorites/index.ts
    const favListMeta = mkMeta(opts, {
      GET: {
        description: 'List favorites for the authenticated user.',
        response: `{ favorites: [] }`,
      },
      POST: {
        description: "Add an entity to the authenticated user's favorites.",
        request: `{ entityId: 'post_01HXZ', entityType: 'post' }`,
        response: `{ message: 'Added to favorites' }`,
        status: 201,
      },
    });
    const favListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${favListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch user favorites
  res.json({ favorites: [] });
};

export const POST = async (req: Request, res: Response) => {
  const { entityId, entityType } = req.body;
  if (!entityId || !entityType) return res.status(400).json({ error: 'entityId and entityType are required' });
  // TODO: add to favorites
  res.status(201).json({ message: 'Added to favorites' });
};
`
      : `${RA}${favListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch user favorites
  res.json({ favorites: [] });
};

export const POST = async (req, res) => {
  const { entityId, entityType } = req.body;
  if (!entityId || !entityType) return res.status(400).json({ error: 'entityId and entityType are required' });
  // TODO: add to favorites
  res.status(201).json({ message: 'Added to favorites' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'favorites', `index.${ext}`),
      favListContent,
    );

    // favorites/[id].ts
    const favByIdMeta = mkMeta(opts, {
      DELETE: {
        description: 'Remove an entity from the authenticated user favorites.',
        params: `{ id: 'fav_01HXZ' }`,
        response: `{ message: 'Removed favorite fav_01HXZ' }`,
      },
    });
    const favByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${favByIdMeta}${mw3}
export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: remove from favorites
  res.json({ message: \`Removed favorite \${id}\` });
};
`
      : `${RA}${favByIdMeta}${mw3}
export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: remove from favorites
  res.json({ message: \`Removed favorite \${id}\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'favorites', `[id].${ext}`),
      favByIdContent,
    );

    // bookmarks/index.ts
    const bkListMeta = mkMeta(opts, {
      GET: {
        description: 'List bookmarks for the authenticated user.',
        response: `{ bookmarks: [] }`,
      },
      POST: {
        description: 'Save a new bookmark for the authenticated user.',
        request: `{ url: 'https://example.com', title: 'Example' }`,
        response: `{ message: 'Bookmark saved' }`,
        status: 201,
      },
    });
    const bkListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${bkListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch user bookmarks
  res.json({ bookmarks: [] });
};

export const POST = async (req: Request, res: Response) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  // TODO: save bookmark
  res.status(201).json({ message: 'Bookmark saved' });
};
`
      : `${RA}${bkListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch user bookmarks
  res.json({ bookmarks: [] });
};

export const POST = async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  // TODO: save bookmark
  res.status(201).json({ message: 'Bookmark saved' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'bookmarks', `index.${ext}`),
      bkListContent,
    );

    // bookmarks/[id].ts
    const bkByIdMeta = mkMeta(opts, {
      DELETE: {
        description: 'Delete a bookmark by ID.',
        params: `{ id: 'bm_01HXZ' }`,
        response: `{ message: 'Bookmark bm_01HXZ removed' }`,
      },
    });
    const bkByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${bkByIdMeta}${mw3}
export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: delete bookmark
  res.json({ message: \`Bookmark \${id} removed\` });
};
`
      : `${RA}${bkByIdMeta}${mw3}
export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: delete bookmark
  res.json({ message: \`Bookmark \${id} removed\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'bookmarks', `[id].${ext}`),
      bkByIdContent,
    );

    // search.ts
    const searchMeta = mkMeta(opts, {
      GET: {
        description: 'Search with filters, sort, and pagination.',
        query: `{ q: 'query', filter: 'active', sort: 'newest', page: '1', limit: '20' }`,
        response: `{ results: [], total: 0, page: 1, limit: 20 }`,
      },
    });
    const searchContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${searchMeta}${mw2}
export const GET = async (req: Request, res: Response) => {
  const { q, filter, sort, page = 1, limit = 20 } = req.query;
  // TODO: implement search
  res.json({ results: [], total: 0, page: Number(page), limit: Number(limit) });
};
`
      : `${RA}${searchMeta}${mw2}
export const GET = async (req, res) => {
  const { q, filter, sort, page = 1, limit = 20 } = req.query;
  // TODO: implement search
  res.json({ results: [], total: 0, page: Number(page), limit: Number(limit) });
};
`;
    await fs.outputFile(path.join(dest, 'src', 'api', 'user', `search.${ext}`), searchContent);
  }

  // api-keys/index.ts
  if (uf.apiAndBilling) {
    const akListMeta = mkMeta(opts, {
      GET: {
        description: 'List API keys for the authenticated user.',
        response: `{ apiKeys: [] }`,
      },
      POST: {
        description: 'Generate a new API key for the authenticated user.',
        request: `{ name: 'CI key' }`,
        response: `{ message: 'API key created', key: 'efc_...' }`,
        status: 201,
      },
    });
    const akListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${akListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch api keys for user
  res.json({ apiKeys: [] });
};

export const POST = async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // TODO: generate and store API key
  res.status(201).json({ message: 'API key created', key: 'efc_...' });
};
`
      : `${RA}${akListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch api keys for user
  res.json({ apiKeys: [] });
};

export const POST = async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // TODO: generate and store API key
  res.status(201).json({ message: 'API key created', key: 'efc_...' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'api-keys', `index.${ext}`),
      akListContent,
    );

    // api-keys/[id].ts
    const akByIdMeta = mkMeta(opts, {
      DELETE: {
        description: 'Revoke and delete an API key by ID.',
        params: `{ id: 'key_01HXZ' }`,
        response: `{ message: 'API key key_01HXZ revoked' }`,
      },
    });
    const akByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${akByIdMeta}${mw3}
export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: revoke and delete API key
  res.json({ message: \`API key \${id} revoked\` });
};
`
      : `${RA}${akByIdMeta}${mw3}
export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: revoke and delete API key
  res.json({ message: \`API key \${id} revoked\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'user', 'api-keys', `[id].${ext}`),
      akByIdContent,
    );
  }
}

async function writeUserBillingRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  // user/billing/* = 3 levels, user/billing/subdir/* = 4 levels
  const mw3 = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const mw4 = mw3;
  const RA = `import { requireAuth } from 'express-file-cluster/auth';\n`;

  // billing/plans.ts
  const plansMeta = mkMeta(opts, {
    GET: { description: 'List all available subscription plans.', response: `{ plans: [] }` },
  });
  const plansContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${plansMeta}${mw3}
export const GET = async (_req: Request, res: Response) => {
  // TODO: fetch active plans from DB
  res.json({ plans: [] });
};
`
    : `${RA}${plansMeta}${mw3}
export const GET = async (_req, res) => {
  // TODO: fetch active plans from DB
  res.json({ plans: [] });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', `plans.${ext}`),
    plansContent,
  );

  // billing/subscription.ts
  const subMeta = mkMeta(opts, {
    GET: {
      description: 'Get the current subscription for the authenticated user.',
      response: `{ subscription: null }`,
    },
    POST: {
      description: 'Subscribe the authenticated user to a plan.',
      request: `{ planId: 'plan_01HXZ' }`,
      response: `{ message: 'Subscribed', subscription: { planId: 'plan_01HXZ' } }`,
      status: 201,
    },
    DELETE: {
      description: 'Cancel the current subscription at period end.',
      response: `{ message: 'Subscription cancelled' }`,
    },
  });
  const subContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${subMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch current subscription for user
  res.json({ subscription: null });
};

export const POST = async (req: Request, res: Response) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId is required' });
  // TODO: create subscription via payment gateway
  res.status(201).json({ message: 'Subscribed', subscription: { planId } });
};

export const DELETE = async (req: Request, res: Response) => {
  // TODO: cancel subscription at period end
  res.json({ message: 'Subscription cancelled' });
};
`
    : `${RA}${subMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch current subscription for user
  res.json({ subscription: null });
};

export const POST = async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId is required' });
  // TODO: create subscription via payment gateway
  res.status(201).json({ message: 'Subscribed', subscription: { planId } });
};

export const DELETE = async (req, res) => {
  // TODO: cancel subscription at period end
  res.json({ message: 'Subscription cancelled' });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', `subscription.${ext}`),
    subContent,
  );

  // billing/payment-methods/index.ts
  const pmListMeta = mkMeta(opts, {
    GET: {
      description: 'List payment methods for the authenticated user.',
      response: `{ paymentMethods: [] }`,
    },
    POST: {
      description: 'Attach a new payment method via the payment gateway.',
      request: `{ token: 'tok_...' }`,
      response: `{ message: 'Payment method added' }`,
      status: 201,
    },
  });
  const pmListContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${pmListMeta}${mw4}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch payment methods for user
  res.json({ paymentMethods: [] });
};

export const POST = async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'payment token is required' });
  // TODO: attach payment method via payment gateway
  res.status(201).json({ message: 'Payment method added' });
};
`
    : `${RA}${pmListMeta}${mw4}
export const GET = async (req, res) => {
  // TODO: fetch payment methods for user
  res.json({ paymentMethods: [] });
};

export const POST = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'payment token is required' });
  // TODO: attach payment method via payment gateway
  res.status(201).json({ message: 'Payment method added' });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', 'payment-methods', `index.${ext}`),
    pmListContent,
  );

  // billing/payment-methods/[id].ts
  const pmByIdMeta = mkMeta(opts, {
    DELETE: {
      description: 'Detach a payment method from the payment gateway.',
      params: `{ id: 'pm_01HXZ' }`,
      response: `{ message: 'Payment method pm_01HXZ removed' }`,
    },
  });
  const pmByIdContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${pmByIdMeta}${mw4}
export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: detach payment method from payment gateway
  res.json({ message: \`Payment method \${id} removed\` });
};
`
    : `${RA}${pmByIdMeta}${mw4}
export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: detach payment method from payment gateway
  res.json({ message: \`Payment method \${id} removed\` });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', 'payment-methods', `[id].${ext}`),
    pmByIdContent,
  );

  // billing/invoices/index.ts
  const invListMeta = mkMeta(opts, {
    GET: {
      description: 'List all invoices for the authenticated user.',
      response: `{ invoices: [], total: 0 }`,
    },
  });
  const invListContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${invListMeta}${mw4}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch invoices for user
  res.json({ invoices: [], total: 0 });
};
`
    : `${RA}${invListMeta}${mw4}
export const GET = async (req, res) => {
  // TODO: fetch invoices for user
  res.json({ invoices: [], total: 0 });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', 'invoices', `index.${ext}`),
    invListContent,
  );

  // billing/invoices/[id].ts
  const invByIdMeta = mkMeta(opts, {
    GET: {
      description: 'Get the download URL for a single invoice by ID.',
      params: `{ id: 'inv_01HXZ' }`,
      response: `{ invoice: { id: 'inv_01HXZ', downloadUrl: 'https://example.com/invoices/inv_01HXZ.pdf' } }`,
    },
  });
  const invByIdContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${invByIdMeta}${mw4}
export const GET = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: return invoice PDF URL or inline data
  res.json({ invoice: { id, downloadUrl: 'https://...' } });
};
`
    : `${RA}${invByIdMeta}${mw4}
export const GET = async (req, res) => {
  const { id } = req.params;
  // TODO: return invoice PDF URL or inline data
  res.json({ invoice: { id, downloadUrl: 'https://...' } });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'user', 'billing', 'invoices', `[id].${ext}`),
    invByIdContent,
  );
}

async function writeSupportRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  // support/tickets/* = 3 levels
  const mw3 = opts.rbac
    ? `export const middlewares = [requireAuth('user', 'admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const RA = `import { requireAuth } from 'express-file-cluster/auth';\n`;

  // support/tickets/index.ts
  const ticketListMeta = mkMeta(opts, {
    GET: {
      description: "List the authenticated user's own support tickets.",
      response: `{ tickets: [], total: 0 }`,
    },
    POST: {
      description: 'Create a new support ticket.',
      request: `{ subject: 'Issue with login', message: 'I cannot log in', priority: 'normal' }`,
      response: `{ message: 'Ticket created', ticket: { id: 'new-id', subject: 'Issue with login', status: 'open' } }`,
      status: 201,
    },
  });
  const ticketListContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${ticketListMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  // TODO: fetch tickets for current user
  res.json({ tickets: [], total: 0 });
};

export const POST = async (req: Request, res: Response) => {
  const { subject, message, priority } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });
  // TODO: create support ticket in DB
  res.status(201).json({ message: 'Ticket created', ticket: { id: 'new-id', subject, status: 'open' } });
};
`
    : `${RA}${ticketListMeta}${mw3}
export const GET = async (req, res) => {
  // TODO: fetch tickets for current user
  res.json({ tickets: [], total: 0 });
};

export const POST = async (req, res) => {
  const { subject, message, priority } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });
  // TODO: create support ticket in DB
  res.status(201).json({ message: 'Ticket created', ticket: { id: 'new-id', subject, status: 'open' } });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'support', 'tickets', `index.${ext}`),
    ticketListContent,
  );

  // support/tickets/[id].ts
  const ticketByIdMeta = mkMeta(opts, {
    GET: {
      description: 'Fetch a single support ticket by ID.',
      params: `{ id: 'tk_01HXZ' }`,
      response: `{ ticket: { id: 'tk_01HXZ', subject: 'Issue', status: 'open', replies: [] } }`,
    },
    PUT: {
      description: 'Add a reply to a support ticket or update its status.',
      params: `{ id: 'tk_01HXZ' }`,
      request: `{ reply: 'Thanks, resolved.', status: 'closed' }`,
      response: `{ message: 'Ticket updated', ticket: { id: 'tk_01HXZ', status: 'closed' } }`,
    },
  });
  const ticketByIdContent = ts
    ? `${RA}import type { Request, Response } from 'express';
${ticketByIdMeta}${mw3}
export const GET = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: fetch ticket by id, verify ownership
  res.json({ ticket: { id, subject: '', status: 'open', replies: [] } });
};

export const PUT = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reply, status } = req.body;
  // TODO: add reply or update status
  res.json({ message: 'Ticket updated', ticket: { id, status: status ?? 'open' } });
};
`
    : `${RA}${ticketByIdMeta}${mw3}
export const GET = async (req, res) => {
  const { id } = req.params;
  // TODO: fetch ticket by id, verify ownership
  res.json({ ticket: { id, subject: '', status: 'open', replies: [] } });
};

export const PUT = async (req, res) => {
  const { id } = req.params;
  const { reply, status } = req.body;
  // TODO: add reply or update status
  res.json({ message: 'Ticket updated', ticket: { id, status: status ?? 'open' } });
};
`;
  await fs.outputFile(
    path.join(dest, 'src', 'api', 'support', 'tickets', `[id].${ext}`),
    ticketByIdContent,
  );
}

async function writeAdminExtendedRoutes(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const ts = opts.language === 'typescript';
  // depth: admin/subdir/* = 3, admin/subdir/subdir/* = 4, admin/users/[id]/* = 4
  const mwAdmin3 = opts.rbac
    ? `export const middlewares = [requireAuth('admin')];\n`
    : `export const middlewares = [requireAuth];\n`;
  const mwAdmin4 = mwAdmin3;
  const roleGuard = opts.rbac
    ? ''
    : ts
      ? `  const user = (req as any).user;\n  if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });\n`
      : `  const user = req.user;\n  if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });\n`;
  const RA = `import { requireAuth } from 'express-file-cluster/auth';\n`;
  const af = opts.adminFeatures;

  // ── Analytics ──────────────────────────────────────────────────────────
  if (af.analytics) {
    // admin/analytics/index.ts
    const analyticsOverviewMeta = mkMeta(opts, {
      GET: {
        description: 'Analytics overview: users, revenue, traffic (admin only).',
        response: `{ users: {}, revenue: {}, traffic: {} }`,
      },
    });
    const analyticsOverviewContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${analyticsOverviewMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  // TODO: aggregate analytics overview
  res.json({ users: {}, revenue: {}, traffic: {} });
};
`
      : `${RA}${analyticsOverviewMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  // TODO: aggregate analytics overview
  res.json({ users: {}, revenue: {}, traffic: {} });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'analytics', `index.${ext}`),
      analyticsOverviewContent,
    );

    const analyticsUsersMeta = mkMeta(opts, {
      GET: {
        description: 'User analytics: registrations, active users, churn (admin only).',
        query: `{ period: '30d' }`,
        response: `{ registrations: [], activeUsers: 0, churn: 0, period: '30d' }`,
      },
    });
    const analyticsUsersContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${analyticsUsersMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch user analytics for period
  res.json({ registrations: [], activeUsers: 0, churn: 0, period });
};
`
      : `${RA}${analyticsUsersMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch user analytics for period
  res.json({ registrations: [], activeUsers: 0, churn: 0, period });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'analytics', `users.${ext}`),
      analyticsUsersContent,
    );

    const analyticsRevenueMeta = mkMeta(opts, {
      GET: {
        description: 'Revenue analytics: MRR, ARR, payment history (admin only).',
        query: `{ period: '30d' }`,
        response: `{ mrr: 0, arr: 0, history: [], period: '30d' }`,
      },
    });
    const analyticsRevenueContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${analyticsRevenueMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch revenue analytics for period
  res.json({ mrr: 0, arr: 0, history: [], period });
};
`
      : `${RA}${analyticsRevenueMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch revenue analytics for period
  res.json({ mrr: 0, arr: 0, history: [], period });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'analytics', `revenue.${ext}`),
      analyticsRevenueContent,
    );

    const analyticsTrafficMeta = mkMeta(opts, {
      GET: {
        description: 'Traffic analytics: page views, devices, countries (admin only).',
        query: `{ period: '30d' }`,
        response: `{ pageViews: 0, devices: {}, countries: {}, period: '30d' }`,
      },
    });
    const analyticsTrafficContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${analyticsTrafficMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch traffic analytics for period
  res.json({ pageViews: 0, devices: {}, countries: {}, period });
};
`
      : `${RA}${analyticsTrafficMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { period = '30d' } = req.query;
  // TODO: fetch traffic analytics for period
  res.json({ pageViews: 0, devices: {}, countries: {}, period });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'analytics', `traffic.${ext}`),
      analyticsTrafficContent,
    );
  }

  // ── User Actions ──────────────────────────────────────────────────────
  if (af.userManagement) {
    // admin/users/[id]/suspend.ts
    const suspendMeta = mkMeta(opts, {
      POST: {
        description: 'Suspend a user account (admin only).',
        params: `{ id: 'usr_01HXZ' }`,
        request: `{ reason: 'Terms of service violation' }`,
        response: `{ message: 'User usr_01HXZ suspended', reason: 'Terms of service violation' }`,
      },
    });
    const suspendContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${suspendMeta}${mwAdmin4}
export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  const { reason } = req.body;
  // TODO: set user.isActive = false, log audit event
  res.json({ message: \`User \${id} suspended\`, reason });
};
`
      : `${RA}${suspendMeta}${mwAdmin4}
export const POST = async (req, res) => {
${roleGuard}  const { id } = req.params;
  const { reason } = req.body;
  // TODO: set user.isActive = false, log audit event
  res.json({ message: \`User \${id} suspended\`, reason });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'users', '[id]', `suspend.${ext}`),
      suspendContent,
    );

    // admin/users/[id]/activate.ts
    const activateMeta = mkMeta(opts, {
      POST: {
        description: 'Reactivate a suspended user account (admin only).',
        params: `{ id: 'usr_01HXZ' }`,
        response: `{ message: 'User usr_01HXZ activated' }`,
      },
    });
    const activateContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${activateMeta}${mwAdmin4}
export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: set user.isActive = true, log audit event
  res.json({ message: \`User \${id} activated\` });
};
`
      : `${RA}${activateMeta}${mwAdmin4}
export const POST = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: set user.isActive = true, log audit event
  res.json({ message: \`User \${id} activated\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'users', '[id]', `activate.${ext}`),
      activateContent,
    );

    // admin/users/[id]/verify.ts
    const verifyUserMeta = mkMeta(opts, {
      POST: {
        description: "Mark a user's email as verified (admin only).",
        params: `{ id: 'usr_01HXZ' }`,
        response: `{ message: 'User usr_01HXZ verified' }`,
      },
    });
    const verifyUserContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${verifyUserMeta}${mwAdmin4}
export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: set user.isVerified = true
  res.json({ message: \`User \${id} verified\` });
};
`
      : `${RA}${verifyUserMeta}${mwAdmin4}
export const POST = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: set user.isVerified = true
  res.json({ message: \`User \${id} verified\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'users', '[id]', `verify.${ext}`),
      verifyUserContent,
    );

    // admin/users/export.ts
    const exportMeta = mkMeta(opts, {
      GET: {
        description: 'Export all users as a CSV download (admin only).',
        response: `'id,name,email,role,createdAt\\n'`,
      },
    });
    const exportContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${exportMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: generate CSV of all users and stream response
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send('id,name,email,role,createdAt\\n');
};
`
      : `${RA}${exportMeta}${mwAdmin3}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: generate CSV of all users and stream response
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send('id,name,email,role,createdAt\\n');
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'users', `export.${ext}`),
      exportContent,
    );
  }

  // ── Admins ────────────────────────────────────────────────────────────
  if (af.adminManagement) {
    // admin/admins/index.ts
    const adminsListMeta = mkMeta(opts, {
      GET: {
        description: 'List all admin accounts (admin only).',
        response: `{ admins: [], total: 0 }`,
      },
      POST: {
        description: 'Create a new admin account (admin only).',
        request: `{ name: 'Jane Doe', email: 'jane@example.com', role: 'admin' }`,
        response: `{ message: 'Admin created', admin: { id: 'new-id', name: 'Jane Doe', email: 'jane@example.com', role: 'admin' } }`,
        status: 201,
      },
    });
    const adminsListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminsListMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: fetch admins from DB
  res.json({ admins: [], total: 0 });
};

export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { name, email, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  // TODO: create admin account
  res.status(201).json({ message: 'Admin created', admin: { id: 'new-id', name, email, role: role ?? 'admin' } });
};
`
      : `${RA}${adminsListMeta}${mwAdmin3}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: fetch admins from DB
  res.json({ admins: [], total: 0 });
};

export const POST = async (req, res) => {
${roleGuard}  const { name, email, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  // TODO: create admin account
  res.status(201).json({ message: 'Admin created', admin: { id: 'new-id', name, email, role: role ?? 'admin' } });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'admins', `index.${ext}`),
      adminsListContent,
    );

    // admin/admins/[id].ts
    const adminByIdMeta = mkMeta(opts, {
      GET: {
        description: 'Fetch a single admin account by ID (admin only).',
        params: `{ id: 'adm_01HXZ' }`,
        response: `{ admin: { id: 'adm_01HXZ' } }`,
      },
      PUT: {
        description: 'Update an admin account by ID (admin only).',
        params: `{ id: 'adm_01HXZ' }`,
        request: `{ name: 'Jane Doe', role: 'admin' }`,
        response: `{ message: 'Admin updated', admin: { id: 'adm_01HXZ', name: 'Jane Doe', role: 'admin' } }`,
      },
      DELETE: {
        description: 'Delete an admin account by ID (admin only).',
        params: `{ id: 'adm_01HXZ' }`,
        response: `{ message: 'Admin adm_01HXZ deleted' }`,
      },
    });
    const adminByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminByIdMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch admin by id
  res.json({ admin: { id } });
};

export const PUT = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: update admin record
  res.json({ message: 'Admin updated', admin: { id, ...req.body } });
};

export const DELETE = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: delete admin
  res.json({ message: \`Admin \${id} deleted\` });
};
`
      : `${RA}${adminByIdMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch admin by id
  res.json({ admin: { id } });
};

export const PUT = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: update admin record
  res.json({ message: 'Admin updated', admin: { id, ...req.body } });
};

export const DELETE = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: delete admin
  res.json({ message: \`Admin \${id} deleted\` });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'admins', `[id].${ext}`),
      adminByIdContent,
    );

    // ── Roles (rbac only) ─────────────────────────────────────────────────

    if (opts.rbac) {
      const rolesListMeta = mkMeta(opts, {
        GET: { description: 'List all roles (admin only).', response: `{ roles: [] }` },
        POST: {
          description: 'Create a new role (admin only).',
          request: `{ name: 'editor', description: 'Can edit content', permissions: ['content:write'] }`,
          response: `{ message: 'Role created', role: { id: 'new-id', name: 'editor', permissions: ['content:write'] } }`,
          status: 201,
        },
      });
      const rolesListContent = ts
        ? `${RA}import type { Request, Response } from 'express';
${rolesListMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
  // TODO: fetch all roles
  res.json({ roles: [] });
};

export const POST = async (req: Request, res: Response) => {
  const { name, description, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // TODO: create role
  res.status(201).json({ message: 'Role created', role: { id: 'new-id', name, permissions: permissions ?? [] } });
};
`
        : `${RA}${rolesListMeta}${mwAdmin3}
export const GET = async (_req, res) => {
  // TODO: fetch all roles
  res.json({ roles: [] });
};

export const POST = async (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // TODO: create role
  res.status(201).json({ message: 'Role created', role: { id: 'new-id', name, permissions: permissions ?? [] } });
};
`;
      await fs.outputFile(
        path.join(dest, 'src', 'api', 'admin', 'roles', `index.${ext}`),
        rolesListContent,
      );

      const roleByIdMeta = mkMeta(opts, {
        GET: {
          description: 'Fetch a single role by ID (admin only).',
          params: `{ id: 'role_01HXZ' }`,
          response: `{ role: { id: 'role_01HXZ', name: 'editor', permissions: ['content:write'] } }`,
        },
        PUT: {
          description: 'Update a role by ID (admin only).',
          params: `{ id: 'role_01HXZ' }`,
          request: `{ name: 'editor', permissions: ['content:write'] }`,
          response: `{ message: 'Role updated', role: { id: 'role_01HXZ', name: 'editor', permissions: ['content:write'] } }`,
        },
        DELETE: {
          description: 'Delete a role by ID (admin only).',
          params: `{ id: 'role_01HXZ' }`,
          response: `{ message: 'Role role_01HXZ deleted' }`,
        },
      });
      const roleByIdContent = ts
        ? `${RA}import type { Request, Response } from 'express';
${roleByIdMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: fetch role by id
  res.json({ role: { id } });
};

export const PUT = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: update role
  res.json({ message: 'Role updated', role: { id, ...req.body } });
};

export const DELETE = async (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: delete role
  res.json({ message: \`Role \${id} deleted\` });
};
`
        : `${RA}${roleByIdMeta}${mwAdmin3}
export const GET = async (req, res) => {
  const { id } = req.params;
  // TODO: fetch role by id
  res.json({ role: { id } });
};

export const PUT = async (req, res) => {
  const { id } = req.params;
  // TODO: update role
  res.json({ message: 'Role updated', role: { id, ...req.body } });
};

export const DELETE = async (req, res) => {
  const { id } = req.params;
  // TODO: delete role
  res.json({ message: \`Role \${id} deleted\` });
};
`;
      await fs.outputFile(
        path.join(dest, 'src', 'api', 'admin', 'roles', `[id].${ext}`),
        roleByIdContent,
      );
    }
  }

  // ── Notifications ─────────────────────────────────────────────────────
  if (af.notificationsAndLogs) {
    // admin/notifications/index.ts
    const adminNotifMeta = mkMeta(opts, {
      GET: {
        description: 'List all sent notifications (admin only).',
        response: `{ notifications: [], total: 0 }`,
      },
      POST: {
        description: 'Send a notification to a specific user (admin only).',
        request: `{ userId: 'usr_01HXZ', title: 'Welcome', message: 'Thanks for joining!', type: 'info' }`,
        response: `{ message: 'Notification sent' }`,
        status: 201,
      },
    });
    const adminNotifContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminNotifMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: fetch sent notifications
  res.json({ notifications: [], total: 0 });
};

export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { userId, title, message, type } = req.body;
  if (!userId || !title || !message) return res.status(400).json({ error: 'userId, title and message are required' });
  // TODO: create and send notification to user
  res.status(201).json({ message: 'Notification sent' });
};
`
      : `${RA}${adminNotifMeta}${mwAdmin3}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: fetch sent notifications
  res.json({ notifications: [], total: 0 });
};

export const POST = async (req, res) => {
${roleGuard}  const { userId, title, message, type } = req.body;
  if (!userId || !title || !message) return res.status(400).json({ error: 'userId, title and message are required' });
  // TODO: create and send notification to user
  res.status(201).json({ message: 'Notification sent' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'notifications', `index.${ext}`),
      adminNotifContent,
    );

    // admin/notifications/broadcast.ts
    const broadcastMeta = mkMeta(opts, {
      POST: {
        description: 'Broadcast a notification to all users (admin only).',
        request: `{ title: 'Announcement', message: 'Hello everyone!', type: 'info' }`,
        response: `{ message: 'Broadcast sent', count: 0 }`,
      },
    });
    const broadcastContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${broadcastMeta}${mwAdmin3}
export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  // TODO: send notification to all users
  res.json({ message: 'Broadcast sent', count: 0 });
};
`
      : `${RA}${broadcastMeta}${mwAdmin3}
export const POST = async (req, res) => {
${roleGuard}  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  // TODO: send notification to all users
  res.json({ message: 'Broadcast sent', count: 0 });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'notifications', `broadcast.${ext}`),
      broadcastContent,
    );

    // ── Logs ──────────────────────────────────────────────────────────────

    const mkLogContent = (label: string) => {
      const meta = mkMeta(opts, {
        GET: {
          description: `Paginated ${label} log entries (admin only).`,
          query: `{ page: '1', limit: '50' }`,
          response: `{ logs: [], total: 0, page: 1, limit: 50 }`,
        },
      });
      return ts
        ? `${RA}import type { Request, Response } from 'express';
${meta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { page = 1, limit = 50 } = req.query;
  // TODO: fetch ${label} logs with pagination
  res.json({ logs: [], total: 0, page: Number(page), limit: Number(limit) });
};
`
        : `${RA}${meta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { page = 1, limit = 50 } = req.query;
  // TODO: fetch ${label} logs with pagination
  res.json({ logs: [], total: 0, page: Number(page), limit: Number(limit) });
};
`;
    };

    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'logs', `audit.${ext}`),
      mkLogContent('audit'),
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'logs', `activity.${ext}`),
      mkLogContent('activity'),
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'logs', `security.${ext}`),
      mkLogContent('security'),
    );
  }

  // ── Settings & System ─────────────────────────────────────────────────
  if (af.systemSettings) {
    // admin/settings/index.ts
    const settingsMeta = mkMeta(opts, {
      GET: { description: 'Get system-wide settings (admin only).', response: `{ settings: {} }` },
      PUT: {
        description: 'Update system-wide settings (admin only).',
        request: `{ maintenanceMode: false }`,
        response: `{ message: 'Settings updated', settings: { maintenanceMode: false } }`,
      },
    });
    const settingsContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${settingsMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: fetch system settings from DB
  res.json({ settings: {} });
};

export const PUT = async (req: Request, res: Response) => {
${roleGuard}  // TODO: update system settings
  res.json({ message: 'Settings updated', settings: req.body });
};
`
      : `${RA}${settingsMeta}${mwAdmin3}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: fetch system settings from DB
  res.json({ settings: {} });
};

export const PUT = async (req, res) => {
${roleGuard}  // TODO: update system settings
  res.json({ message: 'Settings updated', settings: req.body });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'settings', `index.${ext}`),
      settingsContent,
    );

    // admin/system/health.ts
    const healthMeta = mkMeta(opts, {
      GET: {
        description: 'System health check: DB, queue, cache status (admin only).',
        response: `{ status: 'ok', db: 'ok', queue: 'ok', uptime: 12345 }`,
      },
    });
    const healthContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${healthMeta}${mwAdmin3}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: check DB connection, queue, cache health
  res.json({ status: 'ok', db: 'ok', queue: 'ok', uptime: process.uptime() });
};
`
      : `${RA}${healthMeta}${mwAdmin3}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: check DB connection, queue, cache health
  res.json({ status: 'ok', db: 'ok', queue: 'ok', uptime: process.uptime() });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'system', `health.${ext}`),
      healthContent,
    );

    // admin/system/cache.ts
    const cacheMeta = mkMeta(opts, {
      DELETE: {
        description: 'Flush the application cache (admin only).',
        response: `{ message: 'Cache cleared' }`,
      },
    });
    const cacheContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${cacheMeta}${mwAdmin3}
export const DELETE = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: flush Redis or in-memory cache
  res.json({ message: 'Cache cleared' });
};
`
      : `${RA}${cacheMeta}${mwAdmin3}
export const DELETE = async (_req, res) => {
${roleGuard}  // TODO: flush Redis or in-memory cache
  res.json({ message: 'Cache cleared' });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'system', `cache.${ext}`),
      cacheContent,
    );
  }

  // ── Support Tickets (admin view) ──────────────────────────────────────
  if (af.supportManagement) {
    // admin/tickets/index.ts
    const adminTicketsListMeta = mkMeta(opts, {
      GET: {
        description: 'List all support tickets with filters (admin only).',
        query: `{ status: 'open', priority: 'normal', page: '1', limit: '20' }`,
        response: `{ tickets: [], total: 0, page: 1, limit: 20 }`,
      },
    });
    const adminTicketsListContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminTicketsListMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { status, priority, page = 1, limit = 20 } = req.query;
  // TODO: fetch all tickets with filters
  res.json({ tickets: [], total: 0, page: Number(page), limit: Number(limit) });
};
`
      : `${RA}${adminTicketsListMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { status, priority, page = 1, limit = 20 } = req.query;
  // TODO: fetch all tickets with filters
  res.json({ tickets: [], total: 0, page: Number(page), limit: Number(limit) });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'tickets', `index.${ext}`),
      adminTicketsListContent,
    );

    // admin/tickets/[id].ts
    const adminTicketByIdMeta = mkMeta(opts, {
      GET: {
        description: 'Fetch a single support ticket by ID (admin only).',
        params: `{ id: 'tk_01HXZ' }`,
        response: `{ ticket: { id: 'tk_01HXZ' } }`,
      },
      PUT: {
        description: 'Assign, reply to, or change the status of a support ticket (admin only).',
        params: `{ id: 'tk_01HXZ' }`,
        request: `{ reply: 'Looking into it.', status: 'in_progress', assignedTo: 'adm_01HXZ' }`,
        response: `{ message: 'Ticket updated', ticket: { id: 'tk_01HXZ', status: 'in_progress', assignedTo: 'adm_01HXZ' } }`,
      },
    });
    const adminTicketByIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminTicketByIdMeta}${mwAdmin3}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch ticket by id
  res.json({ ticket: { id } });
};

export const PUT = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  const { reply, status, assignedTo } = req.body;
  // TODO: update ticket (assign, change status, add reply)
  res.json({ message: 'Ticket updated', ticket: { id, status, assignedTo } });
};
`
      : `${RA}${adminTicketByIdMeta}${mwAdmin3}
export const GET = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch ticket by id
  res.json({ ticket: { id } });
};

export const PUT = async (req, res) => {
${roleGuard}  const { id } = req.params;
  const { reply, status, assignedTo } = req.body;
  // TODO: update ticket (assign, change status, add reply)
  res.json({ message: 'Ticket updated', ticket: { id, status, assignedTo } });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'tickets', `[id].${ext}`),
      adminTicketByIdContent,
    );
  }

  // Shared by Content (FAQs/blogs/categories) and Billing (plans/coupons) below.
  const mkContentCrud = (name: string, namePlural: string, dir: string[], createFields: string) => {
    const lower = name.toLowerCase();
    const firstField = createFields.split(', ')[0];
    const sampleCreateBody = `{ ${createFields
      .split(', ')
      .map((f) => `${f}: 'sample-${f}'`)
      .join(', ')} }`;
    const sampleCreatedRecord = `{ id: 'new-id', ${firstField}: 'sample-${firstField}' }`;
    const sampleFullRecord = `{ id: '${lower}_01HXZ', ${createFields
      .split(', ')
      .map((f) => `${f}: 'sample-${f}'`)
      .join(', ')} }`;

    const listMeta = mkMeta(opts, {
      GET: {
        description: `List all ${namePlural} (admin only).`,
        response: `{ ${namePlural}: [], total: 0 }`,
      },
      POST: {
        description: `Create a new ${lower} (admin only).`,
        request: sampleCreateBody,
        response: `{ message: '${name} created', ${lower}: ${sampleCreatedRecord} }`,
        status: 201,
      },
    });
    const listContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${listMeta}${mwAdmin4}
export const GET = async (_req: Request, res: Response) => {
${roleGuard}  // TODO: fetch ${namePlural}
  res.json({ ${namePlural}: [], total: 0 });
};

export const POST = async (req: Request, res: Response) => {
${roleGuard}  const { ${createFields} } = req.body;
  // TODO: create ${name}
  res.status(201).json({ message: '${name} created', ${lower}: { id: 'new-id', ${firstField} } });
};
`
      : `${RA}${listMeta}${mwAdmin4}
export const GET = async (_req, res) => {
${roleGuard}  // TODO: fetch ${namePlural}
  res.json({ ${namePlural}: [], total: 0 });
};

export const POST = async (req, res) => {
${roleGuard}  const { ${createFields} } = req.body;
  // TODO: create ${name}
  res.status(201).json({ message: '${name} created', ${lower}: { id: 'new-id' } });
};
`;
    const byIdMeta = mkMeta(opts, {
      GET: {
        description: `Fetch a single ${lower} by ID (admin only).`,
        params: `{ id: '${lower}_01HXZ' }`,
        response: `{ ${lower}: ${sampleFullRecord} }`,
      },
      PUT: {
        description: `Update a ${lower} by ID (admin only).`,
        params: `{ id: '${lower}_01HXZ' }`,
        request: sampleCreateBody,
        response: `{ message: '${name} updated', ${lower}: ${sampleFullRecord} }`,
      },
      DELETE: {
        description: `Delete a ${lower} by ID (admin only).`,
        params: `{ id: '${lower}_01HXZ' }`,
        response: `{ message: '${name} ${lower}_01HXZ deleted' }`,
      },
    });
    const byIdContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${byIdMeta}${mwAdmin4}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch ${name} by id
  res.json({ ${lower}: { id } });
};

export const PUT = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: update ${name}
  res.json({ message: '${name} updated', ${lower}: { id, ...req.body } });
};

export const DELETE = async (req: Request, res: Response) => {
${roleGuard}  const { id } = req.params;
  // TODO: delete ${name}
  res.json({ message: \`${name} \${id} deleted\` });
};
`
      : `${RA}${byIdMeta}${mwAdmin4}
export const GET = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: fetch ${name} by id
  res.json({ ${lower}: { id } });
};

export const PUT = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: update ${name}
  res.json({ message: '${name} updated', ${lower}: { id, ...req.body } });
};

export const DELETE = async (req, res) => {
${roleGuard}  const { id } = req.params;
  // TODO: delete ${name}
  res.json({ message: \`${name} \${id} deleted\` });
};
`;
    return { listContent, byIdContent };
  };

  // ── Content ───────────────────────────────────────────────────────────
  if (af.contentManagement) {
    const { listContent: faqList, byIdContent: faqById } = mkContentCrud(
      'FAQ',
      'faqs',
      [],
      'question, answer, category',
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'faqs', `index.${ext}`),
      faqList,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'faqs', `[id].${ext}`),
      faqById,
    );

    const { listContent: blogList, byIdContent: blogById } = mkContentCrud(
      'Blog',
      'blogs',
      [],
      'title, slug, content',
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'blogs', `index.${ext}`),
      blogList,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'blogs', `[id].${ext}`),
      blogById,
    );

    const { listContent: catList, byIdContent: catById } = mkContentCrud(
      'Category',
      'categories',
      [],
      'name, slug',
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'categories', `index.${ext}`),
      catList,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'content', 'categories', `[id].${ext}`),
      catById,
    );
  }

  // ── Billing (admin) ───────────────────────────────────────────────────
  if (af.billingManagement) {
    const { listContent: planList, byIdContent: planById } = mkContentCrud(
      'Plan',
      'plans',
      [],
      'name, price, interval',
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'billing', 'plans', `index.${ext}`),
      planList,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'billing', 'plans', `[id].${ext}`),
      planById,
    );

    const { listContent: couponList, byIdContent: couponById } = mkContentCrud(
      'Coupon',
      'coupons',
      [],
      'code, type, value',
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'billing', 'coupons', `index.${ext}`),
      couponList,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'billing', 'coupons', `[id].${ext}`),
      couponById,
    );

    // admin/billing/subscriptions/index.ts
    const adminSubsMeta = mkMeta(opts, {
      GET: {
        description: 'List all subscriptions with filters (admin only).',
        query: `{ status: 'active', page: '1', limit: '20' }`,
        response: `{ subscriptions: [], total: 0, page: 1, limit: 20 }`,
      },
    });
    const adminSubsContent = ts
      ? `${RA}import type { Request, Response } from 'express';
${adminSubsMeta}${mwAdmin4}
export const GET = async (req: Request, res: Response) => {
${roleGuard}  const { status, page = 1, limit = 20 } = req.query;
  // TODO: fetch all subscriptions with filters
  res.json({ subscriptions: [], total: 0, page: Number(page), limit: Number(limit) });
};
`
      : `${RA}${adminSubsMeta}${mwAdmin4}
export const GET = async (req, res) => {
${roleGuard}  const { status, page = 1, limit = 20 } = req.query;
  // TODO: fetch all subscriptions with filters
  res.json({ subscriptions: [], total: 0, page: Number(page), limit: Number(limit) });
};
`;
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'admin', 'billing', 'subscriptions', `index.${ext}`),
      adminSubsContent,
    );
  }
}

// defineTable apps: one import that registers every model (so `include` can reach any of
// them) and, in TypeScript, the `Tables` map that types what `include` returns.
async function writeModelIndex(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ts = opts.language === 'typescript';
  const ext = ts ? 'ts' : 'js';
  const names = [...generatedModels(opts)].sort();
  if (names.length === 0) return;
  const exports = names.map((n) => `export { ${n} } from './${n}.js';`).join('\n');
  const tables = ts
    ? `
${names.map((n) => `import type { ${n} } from './${n}.js';`).join('\n')}

// Types \`include\` results: relations name models by string, this maps the names to models.
declare module 'express-file-cluster' {
  interface Tables {
${names.map((n) => `    ${n}: typeof ${n};`).join('\n')}
  }
}
`
    : '';
  const content = `// Every model, in one import: \`import { User } from '../model/index.js'\` also registers the
// models its relations reach, which \`include\` needs.
${exports}
${tables}`;
  await fs.outputFile(path.join(dest, 'src', 'model', `index.${ext}`), content);
}

// Tables before the tables that reference them (create in this order, drop in reverse).
const MODEL_ORDER = [
  'User',
  'Admin',
  'Plan',
  'Category',
  'Role',
  'FAQ',
  'Coupon',
  'OAuthAccount',
  'Session',
  'Notification',
  'File',
  'SupportTicket',
  'AuditLog',
  'Subscription',
  'Invoice',
  'ApiKey',
  'Blog',
];

// Creates every generated model's table/collection (plus indexes) on `efc db migrate`.
// Required on PostgreSQL before first boot; on MongoDB it builds the unique indexes.
async function writeInitMigration(dest: string, opts: ScaffoldOptions): Promise<void> {
  const modelDir = path.join(dest, 'src', 'model');
  if (!(await fs.pathExists(modelDir))) return;
  const ts = opts.language === 'typescript';
  const ext = ts ? 'ts' : 'js';
  const rank = (n: string) =>
    MODEL_ORDER.includes(n) ? MODEL_ORDER.indexOf(n) : MODEL_ORDER.length;
  const names = (await fs.readdir(modelDir))
    .filter((f) => f.endsWith(`.${ext}`) && f !== `index.${ext}`)
    .map((f) => f.slice(0, -(ext.length + 1)))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (names.length === 0) return;

  const imports = names.map((n) => `import { ${n} } from '../model/${n}.js';`).join('\n');
  const typeImport = ts ? "import type { MigrationContext } from 'express-file-cluster';\n" : '';
  const sig = ts ? '(_ctx: MigrationContext): Promise<void>' : '()';
  const content = `${typeImport}${imports}

const models = [${names.join(', ')}];

export async function up${sig} {
  for (const model of models) await model.sync();
}

export async function down${sig} {
  for (const model of [...models].reverse()) await model.drop();
}
`;
  await fs.outputFile(path.join(dest, 'src', 'migrations', `00000000000000_init.${ext}`), content);
}

// ── OAuth sign-in (auth@google, auth@apple) ──────────────────────────────────────────────
// Each provider gets a redirect route and a callback route; both share src/lib/oauth (state
// cookie, find-or-create the user, sign in) and the OAuthAccount model, which links a
// provider identity to a User — so signing in with a provider never changes User itself.

async function writeOAuthAccountModel(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ext = opts.language === 'typescript' ? 'ts' : 'js';
  const content = `${modelApi(opts).import}

// One row per provider identity ("google:<sub>"), linked to the User it signs in as.
export const OAuthAccount = ${modelApi(opts).name}('OAuthAccount', {
  key:        { type: 'string', required: true, unique: true },
  provider:   { type: 'string', required: true, enum: ['google', 'apple'] },
  providerId: { type: 'string', required: true },
  email:      { type: 'string' },
${refField(opts, { field: 'user', target: 'User', legacy: `  userId:     { type: 'string', required: true },`, required: true, onDelete: 'cascade' })}
});
`;
  await fs.outputFile(path.join(dest, 'src', 'model', `OAuthAccount.${ext}`), content);
}

async function writeOAuth(dest: string, opts: ScaffoldOptions): Promise<void> {
  const ts = opts.language === 'typescript';
  const ext = ts ? 'ts' : 'js';
  const db = orm(opts);
  const T = (s: string) => (ts ? s : '');
  // defineTable: a real foreign key `user`; defineModel: the plain `userId` string.
  const userField = usesTables(opts) && generatedModels(opts).has('User') ? 'user' : 'userId';

  const lib = `import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { HttpError } from 'express-file-cluster';
import { issueToken } from 'express-file-cluster/auth';
${T("import type { Request, Response } from 'express';\n")}import { User } from '../model/User.js';
import { OAuthAccount } from '../model/OAuthAccount.js';

// Shared by the OAuth sign-in routes (src/api/auth/<provider>/).

const STATE_TTL_MS = 10 * 60 * 1000; // a sign-in attempt has 10 minutes to come back
${T(`
export interface OAuthState {
  state: string;
  nonce: string;
  verifier?: string;
}

export interface OAuthProfile {
  provider: 'google' | 'apple';
  providerId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}
`)}
/** A random URL-safe string (state, nonce, PKCE verifier). */
export function randomToken()${T(': string')} {
  return crypto.randomBytes(32).toString('base64url');
}

/** The PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier${T(': string')})${T(': string')} {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Remembers a sign-in attempt in a short-lived cookie until the provider redirects back.
 * \`crossSite\`: the provider POSTs the callback from its own site (Apple), so the cookie must
 * be SameSite=None — which browsers only accept with Secure (https, or localhost).
 */
export function rememberState(
  res${T(': Response')},
  provider${T(': string')},
  data${T(': OAuthState')},
  crossSite = false,
)${T(': void')} {
  res.cookie(\`efc_oauth_\${provider}\`, JSON.stringify(data), {
    httpOnly: true,
    secure: crossSite || process.env.NODE_ENV === 'production',
    sameSite: crossSite ? 'none' : 'lax',
    maxAge: STATE_TTL_MS,
    path: '/',
  });
}

/** The remembered attempt (cleared) — or undefined if \`state\` doesn't match it. */
export function takeState(
  req${T(': Request')},
  res${T(': Response')},
  provider${T(': string')},
  state${T(': unknown')},
)${T(': OAuthState | undefined')} {
  const name = \`efc_oauth_\${provider}\`;
  const raw = ${ts ? '(req as Request & { cookies?: Record<string, string> }).cookies?.[name]' : 'req.cookies?.[name]'};
  res.clearCookie(name, { path: '/' });
  if (!raw || typeof state !== 'string') return undefined;
  try {
    const saved = JSON.parse(raw)${T(' as OAuthState')};
    const a = Buffer.from(String(saved.state));
    const b = Buffer.from(state);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signs in the user behind a provider identity: the account already linked to it, else the
 * user with the same (provider-verified) email, else a new user. New users get a random
 * password — they can set a real one with the forgot-password flow.
 */
export async function signInWithOAuth(res${T(': Response')}, profile${T(': OAuthProfile')})${T(': Promise<void>')} {
  const key = \`\${profile.provider}:\${profile.providerId}\`;
  const account = await ${db.findOne('OAuthAccount', '{ key }')};
  let user = account ? await ${db.findById('User', `account.${userField}`)} : null;
  if (!user) {
    if (!profile.email || !profile.emailVerified) {
      throw new HttpError(400, \`\${profile.provider} did not return a verified email address\`);
    }
    const email = profile.email;
    user =
      (await ${db.findOne('User', '{ email }')}) ??
      (await ${db.create(
        'User',
        `{
        name: profile.name || email.split('@')[0],
        email,
        password: await bcrypt.hash(randomToken(), 10),
        isVerified: true,
      }`,
      )});
    if (account) await ${db.update('OAuthAccount', 'account.id', `{ ${userField}: user.id }`)};
    else {
      await ${db.create(
        'OAuthAccount',
        `{
        key,
        provider: profile.provider,
        providerId: profile.providerId,
        email,
        ${userField}: user.id,
      }`,
      )};
    }
  }
  if (!user.isActive) throw new HttpError(403, 'Account suspended');
  await issueToken(res, { id: user.id, role: user.role, email: user.email });
}

/** Where the browser goes once signed in. */
export function successRedirect()${T(': string')} {
  return process.env.OAUTH_SUCCESS_REDIRECT || '/';
}
`;

  const reqRes = (r: string) => (ts ? `(${r}: Request, res: Response)` : `(${r}, res)`);
  const typeImport = T("import type { Request, Response } from 'express';\n");

  const meta = (method: string, description: string) =>
    `${ts ? "import type { RouteMeta } from 'express-file-cluster';\n\n" : ''}export const meta${T(': RouteMeta')} = {\n  ${method}: { description: '${description}' },\n};\n\n`;

  const googleStart = `${typeImport}import { pkceChallenge, randomToken, rememberState } from '../../../lib/oauth.js';
${meta('GET', 'Start "Sign in with Google": redirects to Google.')}// Redirects to Google's consent screen; Google sends the browser back to the callback route
// (GOOGLE_REDIRECT_URI — register that exact URL in the Google Cloud console).
export const GET = async ${reqRes('_req')} => {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  rememberState(res, 'google', { state, nonce, verifier });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect(\`https://accounts.google.com/o/oauth2/v2/auth?\${params}\`);
};
`;

  const googleCallback = `import { HttpError } from 'express-file-cluster';
import { createRemoteJWKSet, jwtVerify } from 'jose';
${typeImport}import { signInWithOAuth, successRedirect, takeState } from '../../../lib/oauth.js';
${meta('GET', 'Google redirects here after sign-in; signs the user in and redirects to OAUTH_SUCCESS_REDIRECT.')}const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export const GET = async ${reqRes('req')} => {
  const { code, state, error } = req.query;
  if (error) throw new HttpError(400, \`Google sign-in failed: \${String(error)}\`);
  const saved = takeState(req, res, 'google', state);
  if (!saved || typeof code !== 'string') {
    throw new HttpError(400, 'Sign-in attempt expired or invalid — start again');
  }

  const tokens = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
      grant_type: 'authorization_code',
      code_verifier: saved.verifier ?? '',
    }),
  });
  if (!tokens.ok) throw new HttpError(502, \`Google rejected the sign-in (\${tokens.status})\`);
  const { id_token } = (await tokens.json())${T(' as { id_token: string }')};

  const { payload } = await jwtVerify(id_token, GOOGLE_KEYS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: process.env.GOOGLE_CLIENT_ID ?? '',
  });
  if (payload.nonce !== saved.nonce) throw new HttpError(400, 'Invalid sign-in response');

  await signInWithOAuth(res, {
    provider: 'google',
    providerId: String(payload.sub),
    email: ${ts ? 'payload.email as string | undefined' : 'payload.email'},
    emailVerified: payload.email_verified === true,
    name: ${ts ? 'payload.name as string | undefined' : 'payload.name'},
  });
  res.redirect(successRedirect());
};
`;

  const appleStart = `${typeImport}import { randomToken, rememberState } from '../../../lib/oauth.js';
${meta('GET', 'Start "Sign in with Apple": redirects to Apple.')}// Redirects to Apple; Apple POSTs the result to the callback route (APPLE_REDIRECT_URI —
// register it on the Services ID; Apple only accepts https URLs on a verified domain).
export const GET = async ${reqRes('_req')} => {
  const state = randomToken();
  const nonce = randomToken();
  rememberState(res, 'apple', { state, nonce }, true);
  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID ?? '',
    redirect_uri: process.env.APPLE_REDIRECT_URI ?? '',
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  });
  res.redirect(\`https://appleid.apple.com/auth/authorize?\${params}\`);
};
`;

  const appleCallback = `import { HttpError } from 'express-file-cluster';
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from 'jose';
${typeImport}import { signInWithOAuth, successRedirect, takeState } from '../../../lib/oauth.js';
${meta('POST', 'Apple posts here after sign-in; signs the user in and redirects to OAUTH_SUCCESS_REDIRECT.')}const APPLE_KEYS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// Apple's client secret is a short-lived ES256 JWT signed with your Sign in with Apple key
// (APPLE_PRIVATE_KEY: the .p8 file's contents, newlines written as \\n).
async function clientSecret()${T(': Promise<string>')} {
  const key = await importPKCS8((process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\\\n/g, '\\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: process.env.APPLE_KEY_ID ?? '' })
    .setIssuer(process.env.APPLE_TEAM_ID ?? '')
    .setSubject(process.env.APPLE_CLIENT_ID ?? '')
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

export const POST = async ${reqRes('req')} => {
  const { code, state, user, error } = req.body ?? {};
  if (error) throw new HttpError(400, \`Apple sign-in failed: \${String(error)}\`);
  const saved = takeState(req, res, 'apple', state);
  if (!saved || typeof code !== 'string') {
    throw new HttpError(400, 'Sign-in attempt expired or invalid — start again');
  }

  const tokens = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.APPLE_CLIENT_ID ?? '',
      client_secret: await clientSecret(),
      redirect_uri: process.env.APPLE_REDIRECT_URI ?? '',
      grant_type: 'authorization_code',
    }),
  });
  if (!tokens.ok) throw new HttpError(502, \`Apple rejected the sign-in (\${tokens.status})\`);
  const { id_token } = (await tokens.json())${T(' as { id_token: string }')};

  const { payload } = await jwtVerify(id_token, APPLE_KEYS, {
    issuer: 'https://appleid.apple.com',
    audience: process.env.APPLE_CLIENT_ID ?? '',
  });
  if (payload.nonce !== saved.nonce) throw new HttpError(400, 'Invalid sign-in response');

  // Apple sends the user's name once, on their first sign-in, as a JSON form field.
  let name${T(': string | undefined')};
  try {
    const n = typeof user === 'string' ? JSON.parse(user).name : undefined;
    name = [n?.firstName, n?.lastName].filter(Boolean).join(' ') || undefined;
  } catch {
    name = undefined;
  }

  await signInWithOAuth(res, {
    provider: 'apple',
    providerId: String(payload.sub),
    email: ${ts ? 'payload.email as string | undefined' : 'payload.email'},
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name,
  });
  res.redirect(303, successRedirect());
};
`;

  const oauth = opts.oauth ?? {};
  await fs.outputFile(path.join(dest, 'src', 'lib', `oauth.${ext}`), lib);
  if (oauth.google) {
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', 'google', `index.${ext}`),
      googleStart,
    );
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', 'google', `callback.${ext}`),
      googleCallback,
    );
  }
  if (oauth.apple) {
    await fs.outputFile(path.join(dest, 'src', 'api', 'auth', 'apple', `index.${ext}`), appleStart);
    await fs.outputFile(
      path.join(dest, 'src', 'api', 'auth', 'apple', `callback.${ext}`),
      appleCallback,
    );
  }
}
