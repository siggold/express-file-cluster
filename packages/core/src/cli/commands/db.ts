import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { readEnvFile } from '../env.js';

function findBin(name: string): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Where migrations/seeds load from: src/ under tsx when it's installed (development),
 * otherwise the compiled dist/src (production images ship without devDependencies),
 * or src/ under plain node for JavaScript projects.
 */
function resolveRuntime(useDist: boolean): { exec: string; root: string } {
  const cwd = process.cwd();
  const src = path.join(cwd, 'src');
  const dist = path.join(cwd, 'dist', 'src');
  const tsx = findBin('tsx');
  if (!useDist && tsx && fs.existsSync(src)) return { exec: tsx, root: src };
  if (fs.existsSync(dist)) return { exec: process.execPath, root: dist };
  return { exec: process.execPath, root: src };
}

function run(
  command: string,
  opts: Record<string, unknown> & { dist?: boolean; databaseUrl?: string },
): void {
  const { exec, root } = resolveRuntime(Boolean(opts.dist));
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db-runner.js');
  const payload = JSON.stringify({ ...opts, root });
  // .env fills gaps; real environment variables win, as with `efc start dev`.
  const env = { ...readEnvFile(), ...process.env };
  const child = spawn(exec, [runner, command, payload], { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const common = (cmd: Command) =>
  cmd
    .option('--database-url <url>', 'override DATABASE_URL')
    .option('--dist', 'load compiled files from dist/src even when tsx is installed');

export function dbCommand(): Command {
  const cmd = new Command('db').description('Database migrations, seeds and studio');

  common(cmd.command('migrate').description('Run pending migrations in src/migrations'))
    .option(
      '--baseline',
      'record pending migrations as applied without running them (the schema already matches)',
    )
    .action((opts: { databaseUrl?: string; dist?: boolean; baseline?: boolean }) =>
      run('migrate', opts),
    );

  common(
    cmd
      .command('generate')
      .description(
        'Write a migration that brings the schema from src/migrations in line with the models',
      )
      .argument('[name]', 'migration name, e.g. add_posts (omit to only print the plan)'),
  )
    .option('--allow-drop', 'also drop columns the models no longer declare (data is lost)')
    .option('--tighten', 'add NOT NULL for required fields and validate enum checks')
    .option(
      '--verify',
      'replay all migrations into a scratch schema and fail if they miss anything',
    )
    .action(
      (
        name: string | undefined,
        opts: {
          databaseUrl?: string;
          dist?: boolean;
          allowDrop?: boolean;
          tighten?: boolean;
          verify?: boolean;
        },
      ) => run('generate', { ...opts, ...(name !== undefined && { name }) }),
    );

  common(cmd.command('rollback').description('Revert the last batch of migrations'))
    .option('--steps <n>', 'number of batches to revert', '1')
    .action((opts: { steps: string; databaseUrl?: string; dist?: boolean }) => {
      const steps = Number(opts.steps);
      if (!Number.isInteger(steps) || steps < 1) {
        console.error(pc.red('--steps must be a positive integer'));
        process.exit(1);
      }
      run('rollback', { ...opts, steps });
    });

  common(
    cmd
      .command('sync')
      .description('Bring tables/collections and indexes in line with the models in src/model(s)'),
  )
    .option('--dry-run', 'print the changes (SQL on PostgreSQL) without applying them')
    .option(
      '--exit-code',
      'with --dry-run: exit with code 2 when there are changes (CI drift check)',
    )
    .action(
      (opts: { databaseUrl?: string; dist?: boolean; dryRun?: boolean; exitCode?: boolean }) =>
        run('sync', opts),
    );

  common(
    cmd
      .command('pull')
      .description('Write defineTable models for the tables in the database (PostgreSQL)'),
  )
    .option('--out <dir>', 'where to write the models', 'src/model')
    .option('--force', 'overwrite model files that already exist')
    .action((opts: { databaseUrl?: string; dist?: boolean; out: string; force?: boolean }) =>
      run('pull', opts),
    );

  common(cmd.command('status').description('List applied and pending migrations')).action(
    (opts: { databaseUrl?: string; dist?: boolean }) => run('status', opts),
  );

  common(
    cmd
      .command('seed')
      .description('Run seed scripts in src/seeds')
      .argument('[name]', 'run only this seed'),
  ).action((name: string | undefined, opts: { databaseUrl?: string; dist?: boolean }) =>
    run('seed', { ...opts, ...(name !== undefined && { seed: name }) }),
  );

  common(cmd.command('studio').description('Open a local, read-only database browser'))
    .option('-p, --port <port>', 'port to listen on (127.0.0.1 only)', '4983')
    .action((opts: { port: string; databaseUrl?: string; dist?: boolean }) =>
      run('studio', { ...opts, port: Number(opts.port) }),
    );

  return cmd;
}
