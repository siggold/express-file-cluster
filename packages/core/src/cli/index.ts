#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { buildCommand } from './commands/build.js';
import { runCommand } from './commands/run.js';
import { generateCommand } from './commands/generate.js';
import { diagnosticsCommands } from './commands/diagnostics.js';
import { dbCommand } from './commands/db.js';
import { registryCommands } from './commands/registry.js';
import { importPrismaCommand } from './commands/import-prisma.js';

// package.json sits two levels up from both src/cli/index.ts and dist/cli/index.js.
const { version } = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// A globally installed `efc` must not run a project's commands itself: it would resolve
// drivers (mongoose, pg, ...) from the global install and load a second copy of the
// framework alongside the project's own. If the project has its own express-file-cluster,
// hand the whole invocation to that copy — same as eslint, jest and friends do.
function localCli(): string | undefined {
  if (process.env['EFC_CLI_DELEGATED']) return undefined;
  const self = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', 'express-file-cluster');
    if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
      const real = fs.realpathSync(pkgDir);
      const cli = path.join(real, 'dist', 'cli', 'index.js');
      return real !== self && fs.existsSync(cli) ? cli : undefined;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

const delegate = localCli();
if (delegate) {
  const child = spawn(process.execPath, [delegate, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, EFC_CLI_DELEGATED: '1' },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  run();
}

function run(): void {
  const program = new Command('efc').description('Express File Cluster CLI').version(version);

  program.addCommand(startCommand());
  program.addCommand(buildCommand());
  program.addCommand(runCommand());
  program.addCommand(generateCommand());
  program.addCommand(dbCommand());
  program.addCommand(importPrismaCommand());
  for (const cmd of registryCommands()) program.addCommand(cmd);

  for (const cmd of diagnosticsCommands()) {
    program.addCommand(cmd);
  }

  program.parse(process.argv);
}
