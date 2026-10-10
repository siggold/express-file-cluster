#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { buildCommand } from './commands/build.js';
import { runCommand } from './commands/run.js';
import { generateCommand } from './commands/generate.js';
import { diagnosticsCommands } from './commands/diagnostics.js';
import { dbCommand } from './commands/db.js';

// package.json sits two levels up from both src/cli/index.ts and dist/cli/index.js.
const { version } = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command('efc').description('Express File Cluster CLI').version(version);

program.addCommand(startCommand());
program.addCommand(buildCommand());
program.addCommand(runCommand());
program.addCommand(generateCommand());
program.addCommand(dbCommand());

for (const cmd of diagnosticsCommands()) {
  program.addCommand(cmd);
}

program.parse(process.argv);
