import * as p from '@clack/prompts';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { scaffold, type ScaffoldOptions } from './scaffold.js';
import {
  ITEMS,
  envFromAnswers,
  itemPrompts,
  normalizeAnswer,
  promptApplies,
  promptDefault,
  registryOptions,
  setEnvValues,
  withDependencies,
  writeManifest,
  type PromptAnswers,
} from './registry.js';

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

  const database = await p.select({
    message: 'Database:',
    options: [
      { value: 'mongodb', label: 'MongoDB', hint: 'Mongoose' },
      { value: 'postgresql', label: 'PostgreSQL', hint: 'Drizzle ORM' },
    ],
  });
  if (p.isCancel(database)) cancel();

  let modelApi: ScaffoldOptions['modelApi'];
  if (database === 'postgresql') {
    const api = await p.select({
      message: 'Models:',
      options: [
        {
          value: 'defineTable',
          label: 'defineTable',
          hint: 'PostgreSQL-native — foreign keys, relations, include, Prisma-style queries',
        },
        { value: 'defineModel', label: 'defineModel', hint: 'portable — the same API on MongoDB' },
      ],
    });
    if (p.isCancel(api)) cancel();
    modelApi = api as ScaffoldOptions['modelApi'];
  }

  // pg-boss keeps jobs in the app's own PostgreSQL; BullMQ needs Redis.
  const taskBackend = await p.select({
    message: 'Task queue backend:',
    options:
      database === 'postgresql'
        ? [
            { value: 'pg-boss', label: 'pg-boss', hint: 'uses your PostgreSQL — no Redis' },
            { value: 'bullmq', label: 'BullMQ', hint: 'Redis' },
          ]
        : [{ value: 'bullmq', label: 'BullMQ', hint: 'Redis' }],
  });
  if (p.isCancel(taskBackend)) cancel();

  const cluster = await p.confirm({
    message: 'Multi-core clustering? (one worker per CPU in production)',
    initialValue: true,
  });
  if (p.isCancel(cluster)) cancel();

  // The base app is the server, src/api, src/tasks and the database. Features are registry
  // items — the same ones `efc add` installs later.
  const groupLabel: Record<string, string> = {
    auth: 'Auth',
    user: 'User portal',
    admin: 'Admin portal',
    integrations: 'Integrations',
  };
  const groups: Record<string, { value: string; label: string; hint: string }[]> = {};
  for (const item of ITEMS) {
    (groups[groupLabel[item.group]!] ??= []).push({
      value: item.name,
      label: item.title,
      hint: item.description,
    });
  }
  const picked = await p.groupMultiselect({
    message: `Add features now? ${pc.dim('(space to toggle, enter to confirm — or add any later with `efc add <item>`)')}`,
    options: groups,
    required: false,
  });
  if (p.isCancel(picked)) cancel();
  const items = withDependencies(picked as string[]);

  let authStrategy: ScaffoldOptions['authStrategy'] = 'http-only';
  if (items.includes('auth')) {
    const strategy = await p.select({
      message: 'Authentication strategy:',
      options: [
        { value: 'http-only', label: 'http-only', hint: 'secure cookie — recommended for SSR' },
        { value: 'localStorage', label: 'localStorage', hint: 'bearer token — for SPAs' },
      ],
    });
    if (p.isCancel(strategy)) cancel();
    authStrategy = strategy as ScaffoldOptions['authStrategy'];
  }

  // Each feature's own questions (SMTP for the email client, OAuth credentials…) — the same
  // ones `efc add` asks. Answers named like env vars go into .env.
  const answers: PromptAnswers = {};
  const prompts = itemPrompts(items);
  for (const q of prompts) {
    if (!promptApplies(q, answers)) continue;
    if (q.note) p.note(q.note);
    if (q.type === 'select') {
      const choice = await p.select({
        message: q.message,
        options: (q.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          ...(o.hint !== undefined && { hint: o.hint }),
        })),
      });
      if (p.isCancel(choice)) cancel();
      answers[q.name] = choice as string;
      continue;
    }
    const def = promptDefault(q, answers);
    const check = (v: string) => {
      const r = normalizeAnswer(q, v.trim() === '' ? (def ?? '') : v);
      return 'error' in r ? r.error : undefined;
    };
    const raw =
      q.type === 'password'
        ? await p.password({ message: q.message, validate: check })
        : await p.text({
            message: q.message,
            ...(q.placeholder !== undefined && { placeholder: q.placeholder }),
            ...(def !== undefined && { placeholder: def, defaultValue: def }),
            validate: check,
          });
    if (p.isCancel(raw)) cancel();
    const r = normalizeAnswer(q, (raw as string).trim() === '' ? (def ?? '') : (raw as string));
    answers[q.name] = 'value' in r ? r.value : '';
  }
  const env = envFromAnswers(prompts, answers);

  const opts = registryOptions(
    {
      language: language as ScaffoldOptions['language'],
      database: database as ScaffoldOptions['database'],
      modelApi: modelApi ?? 'defineModel',
    },
    items,
    {
      projectName: projectName as string,
      authStrategy,
      cluster: cluster as boolean,
      taskBackend: taskBackend as 'bullmq' | 'pg-boss',
      ...(answers['provider'] === 'custom' && { smtpProvider: 'custom' as const }),
    },
  );

  const spinner = p.spinner();
  spinner.start('Scaffolding project…');

  try {
    await scaffold(opts);
    if (Object.keys(env).length) {
      await setEnvValues(path.resolve(process.cwd(), opts.projectName, '.env'), env);
    }
    await writeManifest(path.resolve(process.cwd(), opts.projectName), opts, items);
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
  await npmInstallGlobal().catch(() => {
    /* non-fatal */
  });
  spinner.stop('efc CLI ready');

  const secrets = Object.keys(env).filter((k) => /PASS|SECRET|PRIVATE_KEY/.test(k));
  if (secrets.length) {
    p.note(
      `${secrets.join(', ')} ${secrets.length > 1 ? 'were' : 'was'} written to ${projectName as string}/.env — that file is gitignored, never commit it.\n` +
        'Rotate any of them immediately if it is ever exposed.',
      'Credentials',
    );
  }

  // Tables (PostgreSQL) and collections/indexes (MongoDB) are created on first use, so
  // there's nothing to set up before the first run; migrations are there when wanted.
  p.outro(
    pc.green(`\nYour project is ready!\n\n`) +
      pc.dim(`  cd ${projectName as string}\n`) +
      pc.dim(`  efc start dev\n`) +
      pc.dim(`\n  (or: npm run dev)\n`) +
      pc.dim(`\n  Add features any time: efc list · efc add <item>\n`),
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
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('global install failed')),
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
