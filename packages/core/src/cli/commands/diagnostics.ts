import { Command } from 'commander';
import { scanDir } from '../../router/scan.js';
import path from 'node:path';
import fs from 'node:fs';
import pc from 'picocolors';
import { readEnvFile } from '../env.js';
import { taskAdminCommands } from './task-admin.js';

export function diagnosticsCommands(): Command[] {
  return [routesCommand(), tasksCommand(), doctorCommand()];
}

function routesCommand(): Command {
  return new Command('routes').description('Print the resolved route table').action(() => {
    const apiDir = resolveApiDir();
    if (!apiDir) {
      console.error(pc.red('[EFC] Could not find apiDir (expected src/api)'));
      process.exit(1);
    }

    const routes = scanDir(apiDir);
    if (routes.length === 0) {
      console.log(pc.yellow('No routes found.'));
      return;
    }

    console.log(pc.bold('\n  Route Table\n'));
    console.log(pc.dim('  ' + '─'.repeat(60)));
    for (const route of routes) {
      const rel = path.relative(process.cwd(), route.filePath);
      console.log(`  ${pc.cyan(route.urlPath.padEnd(35))} ${pc.dim(rel)}`);
    }
    console.log(pc.dim('  ' + '─'.repeat(60)));
    console.log(pc.dim(`\n  ${routes.length} route(s) found\n`));
  });
}

function tasksCommand(): Command {
  const cmd = new Command('tasks').description(
    'List background tasks, or inspect the dead-letter queue (failed | retry | purge)',
  );
  for (const sub of taskAdminCommands()) cmd.addCommand(sub);
  return cmd.action(() => {
    const tasksDir = resolveTasksDir();
    if (!tasksDir || !fs.existsSync(tasksDir)) {
      console.log(pc.yellow('No tasks directory found.'));
      return;
    }

    const files = fs.readdirSync(tasksDir).filter((f) => /\.(ts|js)$/.test(f));
    if (files.length === 0) {
      console.log(pc.yellow('No tasks found.'));
      return;
    }

    console.log(pc.bold('\n  Background Tasks\n'));
    for (const file of files) {
      console.log(`  ${pc.cyan(path.basename(file, path.extname(file)))}`);
    }
    console.log();
  });
}

function doctorCommand(): Command {
  return new Command('doctor')
    .description('Validate config, env vars, and project setup')
    .action(() => {
      const cwd = process.cwd();
      const envFileVars = readEnvFile(cwd);
      const hasEnvVar = (key: string): boolean =>
        Boolean(process.env[key]) || Boolean(envFileVars[key]);

      const checks: { label: string; ok: boolean; hint?: string }[] = [
        {
          label: 'package.json exists',
          ok: fs.existsSync(path.join(cwd, 'package.json')),
        },
        {
          label: 'tsconfig.json exists',
          ok: fs.existsSync(path.join(cwd, 'tsconfig.json')),
          hint: 'Run `tsc --init` to create one',
        },
        {
          label: 'src/api directory exists',
          ok: fs.existsSync(path.join(cwd, 'src', 'api')),
          hint: 'Create src/api/ and add route files',
        },
        {
          label: 'DATABASE_URL set',
          ok: hasEnvVar('DATABASE_URL'),
          hint: 'Add DATABASE_URL to .env',
        },
        {
          label: 'JWT_SECRET set',
          ok: hasEnvVar('JWT_SECRET'),
          hint: 'Add JWT_SECRET to .env (generate: openssl rand -hex 64)',
        },
      ];

      console.log(pc.bold('\n  EFC Doctor\n'));
      let allOk = true;
      for (const check of checks) {
        const icon = check.ok ? pc.green('✓') : pc.red('✗');
        console.log(`  ${icon}  ${check.label}`);
        if (!check.ok) {
          allOk = false;
          if (check.hint) console.log(pc.dim(`       → ${check.hint}`));
        }
      }
      console.log();
      if (allOk) {
        console.log(pc.green('  All checks passed!\n'));
      } else {
        console.log(pc.yellow('  Some checks failed. Fix the issues above.\n'));
        process.exit(1);
      }
    });
}

function resolveApiDir(): string | null {
  const cwd = process.cwd();
  const candidates = [path.join(cwd, 'src', 'api'), path.join(cwd, 'api')];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

function resolveTasksDir(): string | null {
  const cwd = process.cwd();
  const candidates = [path.join(cwd, 'src', 'tasks'), path.join(cwd, 'tasks')];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}
