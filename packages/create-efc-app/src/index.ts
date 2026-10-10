import * as p from '@clack/prompts';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import { scaffold, type ScaffoldOptions, type AdminFeatures, type UserFeatures, NO_ADMIN_FEATURES, NO_USER_FEATURES } from './scaffold.js';

function cancel(msg = 'Cancelled'): never {
  p.cancel(msg);
  process.exit(0);
}

async function main(): Promise<void> {
  console.log();
  p.intro(pc.bgCyan(pc.black(' create-efc-app ')));

  const projectName = await p.text({
    message: 'Project name:',
    placeholder: 'my-api',
    defaultValue: 'my-api',
    validate: (v) => (!v.trim() ? 'Project name is required' : undefined),
  });
  if (p.isCancel(projectName)) cancel();

  const language = await p.select({
    message: 'Language:',
    options: [
      { value: 'typescript', label: 'TypeScript', hint: 'recommended' },
      { value: 'javascript', label: 'JavaScript' },
    ],
  });
  if (p.isCancel(language)) cancel();

  // MongoDB is the only adapter the runtime connects today; PostgreSQL (Drizzle) is Phase 2.
  // Offering it here would generate a project whose database is never connected.
  const database: ScaffoldOptions['database'] = 'mongodb';
  p.log.info(`Database: MongoDB ${pc.dim('(PostgreSQL arrives in Phase 2)')}`);

  const authStrategy = await p.select({
    message: 'Authentication strategy:',
    options: [
      { value: 'http-only', label: 'http-only', hint: 'secure cookie — recommended for SSR' },
      { value: 'localStorage', label: 'localStorage', hint: 'bearer token — for SPAs' },
    ],
  });
  if (p.isCancel(authStrategy)) cancel();

  const features = await p.multiselect({
    message: 'Features: (space to toggle, enter to confirm)',
    options: [
      { value: 'cluster',    label: 'Multi-core clustering',          hint: 'Node cluster module' },
      { value: 'tasks',      label: 'Background tasks',               hint: 'BullMQ (Redis)' },
      { value: 'routeDocs',  label: 'API route documentation',        hint: 'meta exports + dashboard' },
      { value: 'userPortal', label: 'User portal',                    hint: 'auth, profile, billing routes' },
      { value: 'adminPortal',label: 'Admin portal',                   hint: 'dashboard, user mgmt, analytics' },
      { value: 'rbac',       label: 'Role-based access control',      hint: "requireAuth('role') middleware" },
      { value: 'mailer',     label: 'Mailer',                         hint: 'nodemailer + SMTP' },
    ],
    initialValues: ['cluster', 'tasks', 'routeDocs', 'userPortal', 'adminPortal', 'rbac'],
    required: false,
  });
  if (p.isCancel(features)) cancel();

  const selected = new Set(features as string[]);

  let userFeatures: UserFeatures = NO_USER_FEATURES;
  if (selected.has('userPortal')) {
    const chosen = await p.multiselect({
      message: 'User portal features: (space to toggle, enter to confirm)',
      options: [
        { value: 'profileViewing',   label: 'Profile viewing & editing', hint: 'GET/PUT /user/profile' },
        { value: 'forgotPassword',   label: 'Forgot / reset password',   hint: 'forgot-password, reset-password' },
        { value: 'accountSecurity',  label: 'Change password, 2FA & sessions', hint: 'change-password, 2fa/*, sessions/*, token refresh' },
        { value: 'emailVerification',label: 'Email verification',        hint: 'verify-email route + registration flow' },
        { value: 'accountSettings',  label: 'Account settings',          hint: 'avatar, settings, account, dashboard, activity' },
        { value: 'notifications',    label: 'Notifications',             hint: 'user/notifications' },
        { value: 'filesAndMedia',    label: 'Files, favorites & bookmarks', hint: 'files, favorites, bookmarks, search' },
        { value: 'apiAndBilling',    label: 'API keys & billing',        hint: 'api-keys, plans, subscription, invoices' },
        { value: 'support',         label: 'Support tickets',           hint: 'create & view own tickets' },
      ],
      initialValues: ['profileViewing', 'forgotPassword', 'accountSecurity', 'emailVerification', 'accountSettings', 'notifications', 'filesAndMedia', 'apiAndBilling', 'support'],
      required: false,
    });
    if (p.isCancel(chosen)) cancel();
    const uSet = new Set(chosen as string[]);
    userFeatures = {
      profileViewing: uSet.has('profileViewing'),
      forgotPassword: uSet.has('forgotPassword'),
      accountSecurity: uSet.has('accountSecurity'),
      emailVerification: uSet.has('emailVerification'),
      accountSettings: uSet.has('accountSettings'),
      notifications: uSet.has('notifications'),
      filesAndMedia: uSet.has('filesAndMedia'),
      apiAndBilling: uSet.has('apiAndBilling'),
      support: uSet.has('support'),
    };
  }

  let adminFeatures: AdminFeatures = NO_ADMIN_FEATURES;
  if (selected.has('adminPortal')) {
    const chosen = await p.multiselect({
      message: 'Admin panel features: (space to toggle, enter to confirm)',
      options: [
        { value: 'userManagement',       label: 'User management', hint: 'list/create/suspend/verify/export users + dashboard stats' },
        { value: 'adminManagement',      label: 'Admin & role management', hint: 'manage other admins' + (selected.has('rbac') ? ' + roles' : '') },
        { value: 'analytics',            label: 'Analytics',       hint: 'users, revenue, traffic dashboards' },
        { value: 'contentManagement',    label: 'Content management', hint: 'FAQs, blog posts, categories' },
        { value: 'billingManagement',    label: 'Billing management', hint: 'plans, coupons, subscriptions' },
        { value: 'supportManagement',    label: 'Support tickets', hint: 'view & respond to tickets' },
        { value: 'notificationsAndLogs', label: 'Notifications & audit logs', hint: 'broadcast + audit/activity/security logs' },
        { value: 'systemSettings',       label: 'System settings & health', hint: 'app settings, health check, cache' },
      ],
      initialValues: ['userManagement', 'adminManagement', 'analytics', 'contentManagement', 'billingManagement', 'supportManagement', 'notificationsAndLogs', 'systemSettings'],
      required: false,
    });
    if (p.isCancel(chosen)) cancel();
    const aSet = new Set(chosen as string[]);
    adminFeatures = {
      userManagement: aSet.has('userManagement'),
      adminManagement: aSet.has('adminManagement'),
      analytics: aSet.has('analytics'),
      contentManagement: aSet.has('contentManagement'),
      billingManagement: aSet.has('billingManagement'),
      supportManagement: aSet.has('supportManagement'),
      notificationsAndLogs: aSet.has('notificationsAndLogs'),
      systemSettings: aSet.has('systemSettings'),
    };
  }

  // BullMQ is the only backend the runtime starts; pg-boss is Phase 2.
  let taskBackend: ScaffoldOptions['taskBackend'];
  if (selected.has('tasks')) {
    taskBackend = 'bullmq';
    p.log.info(`Task queue: BullMQ (Redis) ${pc.dim('(pg-boss arrives in Phase 2)')}`);
  }

  let smtpProvider: ScaffoldOptions['smtpProvider'];
  let smtpHost: string | undefined;
  let smtpPort: string | undefined;
  let smtpUser: string | undefined;
  let smtpPass: string | undefined;
  if (selected.has('mailer')) {
    const provider = await p.select({
      message: 'Email provider:',
      options: [
        { value: 'gmail', label: 'Gmail', hint: 'smtp.gmail.com, preconfigured' },
        { value: 'custom', label: 'Other (custom SMTP)', hint: "you'll provide host + port" },
      ],
    });
    if (p.isCancel(provider)) cancel();
    smtpProvider = provider as ScaffoldOptions['smtpProvider'];

    if (smtpProvider === 'custom') {
      const host = await p.text({
        message: 'SMTP host:',
        placeholder: 'smtp.mailtrap.io',
        validate: (v) => (!v.trim() ? 'SMTP host is required' : undefined),
      });
      if (p.isCancel(host)) cancel();
      smtpHost = host as string;

      const port = await p.text({
        message: 'SMTP port:',
        placeholder: '587',
        defaultValue: '587',
      });
      if (p.isCancel(port)) cancel();
      smtpPort = port as string;
    }

    const user = await p.text({
      message: smtpProvider === 'gmail' ? 'Gmail address:' : 'SMTP username / email:',
      placeholder: 'you@example.com',
      validate: (v) => (!v.trim() ? 'Email is required' : undefined),
    });
    if (p.isCancel(user)) cancel();
    smtpUser = user as string;

    if (smtpProvider === 'gmail') {
      p.note(
        'Google no longer accepts your regular account password for SMTP.\n' +
          "Generate a 16-character App Password: Google Account -> Security -> 2-Step Verification -> App passwords.\n" +
          "Enter it below without spaces (not your Gmail login password).",
        'Gmail app password required',
      );
    }

    const pass = await p.password({
      message: smtpProvider === 'gmail' ? 'Gmail app password (16 characters):' : 'SMTP password:',
      validate: (v) => {
        if (!v.trim()) return 'Password is required';
        if (smtpProvider === 'gmail' && v.replace(/\s/g, '').length !== 16) {
          return 'Gmail app passwords are 16 characters — this looks like a regular password, not an app password';
        }
        return undefined;
      },
    });
    if (p.isCancel(pass)) cancel();
    smtpPass = (pass as string).replace(/\s/g, '');
  }

  const opts: ScaffoldOptions = {
    projectName: projectName as string,
    language: language as ScaffoldOptions['language'],
    database,
    authStrategy: authStrategy as ScaffoldOptions['authStrategy'],
    cluster:     selected.has('cluster'),
    tasks:       selected.has('tasks'),
    routeDocs:   selected.has('routeDocs'),
    userPortal:  selected.has('userPortal'),
    adminPortal: selected.has('adminPortal'),
    userFeatures,
    adminFeatures,
    rbac:        selected.has('rbac'),
    mailer:      selected.has('mailer'),
    ...(taskBackend   !== undefined && { taskBackend }),
    ...(smtpProvider  !== undefined && { smtpProvider }),
    ...(smtpHost      !== undefined && { smtpHost }),
    ...(smtpPort      !== undefined && { smtpPort }),
    ...(smtpUser      !== undefined && { smtpUser }),
    ...(smtpPass      !== undefined && { smtpPass }),
  };

  const spinner = p.spinner();
  spinner.start('Scaffolding project…');

  try {
    await scaffold(opts);
    spinner.stop('Project created');
  } catch (err) {
    spinner.stop('Failed to scaffold project');
    console.error(err);
    process.exit(1);
  }

  spinner.start('Installing dependencies…');
  await npmInstall(projectName as string);
  spinner.stop('Dependencies installed');

  spinner.start('Installing efc CLI globally…');
  await npmInstallGlobal().catch(() => { /* non-fatal */ });
  spinner.stop('efc CLI ready');

  if (opts.mailer) {
    p.note(
      `SMTP_USER and SMTP_PASS were written to ${projectName as string}/.env — that file is gitignored, never commit it.\n` +
        (opts.smtpProvider === 'gmail'
          ? 'If this Gmail app password ever leaks, revoke it and generate a new one.'
          : 'Rotate SMTP_PASS immediately if it is ever exposed.'),
      'Mailer credentials',
    );
  }

  p.outro(
    pc.green(`\nYour project is ready!\n\n`) +
      pc.dim(`  cd ${projectName as string}\n`) +
      pc.dim(`  efc start dev\n`) +
      pc.dim(`\n  (or: npm run dev)\n`),
  );
}

function npmInstall(projectDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install'], { cwd: projectDir, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
  });
}

function npmInstallGlobal(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', 'express-file-cluster'], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('global install failed'))));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
