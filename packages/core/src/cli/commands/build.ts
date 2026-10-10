import { Command } from 'commander';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import pc from 'picocolors';

export function buildCommand(): Command {
  const cmd = new Command('build');

  cmd
    .argument('<mode>', 'prod')
    .description('Build the application for production')
    .action((mode: string) => {
      if (mode !== 'prod') {
        console.error(pc.red(`Unknown build mode: ${mode}. Use 'prod'.`));
        process.exit(1);
      }
      buildProd();
    });

  return cmd;
}

function findBin(name: string): string {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return name; // fell off root, hope it's on PATH
    dir = parent;
  }
}

// Routes and tasks are discovered by scanning the filesystem at runtime, so bundling
// from src/index.ts would leave them out of dist/ entirely (and bundling each file would
// duplicate shared modules like models). Instead every source file is transpiled 1:1:
// src/api/users.ts → dist/src/api/users.js, with efc.config.ts → dist/efc.config.js.
// tsup's CLI can't turn bundling off, so the config is generated per build.
function writeAppTsupConfig(cwd: string): string {
  const pkgPath = path.join(cwd, 'package.json');
  const isEsm =
    fs.existsSync(pkgPath) &&
    (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { type?: string }).type === 'module';
  const entry = [
    'src/**/*.{ts,mts,js,mjs}',
    ...['efc.config.ts', 'efc.config.js'].filter((f) => fs.existsSync(path.join(cwd, f))),
    '!src/**/*.d.ts',
    '!src/**/*.test.*',
    '!src/**/__tests__/**',
  ];
  const config = `export default {
  entry: ${JSON.stringify(entry)},
  outDir: 'dist',
  format: ['${isEsm ? 'esm' : 'cjs'}'],
  bundle: false,
  splitting: false,
  clean: true,
  sourcemap: true,
  platform: 'node',
  target: 'node18',
  esbuildOptions(options) {
    options.outbase = '.';
  },
};
`;
  const configPath = path.join(cwd, 'node_modules', '.cache', 'efc', 'tsup.config.mjs');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  return configPath;
}

function hasTsupConfig(): boolean {
  const cwd = process.cwd();
  return ['tsup.config.ts', 'tsup.config.js', 'tsup.config.mjs', 'tsup.config.cjs'].some((f) =>
    fs.existsSync(path.join(cwd, f)),
  );
}

function findTsConfig(): string | null {
  const cwd = process.cwd();
  const tsconfig = path.join(cwd, 'tsconfig.json');
  return fs.existsSync(tsconfig) ? tsconfig : null;
}

function buildProd(): void {
  console.log(pc.cyan('[EFC] Building for production…'));

  const tsconfig = findTsConfig();
  if (!tsconfig) {
    // JavaScript project — nothing to typecheck, but routes/tasks still need to land in dist/.
    transpile();
    return;
  }

  const tsc = spawn(findBin('tsc'), ['--noEmit', '--project', tsconfig], { stdio: 'inherit' });

  tsc.on('exit', (code) => {
    if (code !== 0) {
      console.error(pc.red('[EFC] TypeScript errors found. Fix them before building.'));
      process.exit(1);
    }
    transpile();
  });
}

// JavaScript projects need no transpiling (tsup can't even load without typescript
// installed): mirror src/ and efc.config.js into dist/ with the same layout tsup
// would produce, so `efc start prod` and `efc db --dist` find the same paths.
function copyJsProject(cwd: string): void {
  const dist = path.join(cwd, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(path.join(cwd, 'src'), path.join(dist, 'src'), {
    recursive: true,
    filter: (src) => !/(\.test\.[cm]?js$|[\\/]__tests__([\\/]|$))/.test(src),
  });
  for (const f of ['efc.config.js', 'efc.config.mjs']) {
    if (fs.existsSync(path.join(cwd, f))) fs.copyFileSync(path.join(cwd, f), path.join(dist, f));
  }
  console.log(pc.green('[EFC] Build complete → dist/ (JavaScript copied as-is)'));
}

function transpile(): void {
  let tsupArgs: string[];
  const cwd = process.cwd();
  if (hasTsupConfig()) {
    tsupArgs = [];
  } else {
    const hasTs = fs.existsSync(path.join(cwd, 'src', 'index.ts'));
    if (!hasTs && !fs.existsSync(path.join(cwd, 'src', 'index.js'))) {
      console.error(pc.red('[EFC] Could not find entry point. Expected src/index.ts'));
      process.exit(1);
      return;
    }
    if (!hasTs && !findTsConfig()) {
      copyJsProject(cwd);
      return;
    }
    tsupArgs = ['--config', writeAppTsupConfig(cwd)];
  }

  const tsup = spawn(findBin('tsup'), tsupArgs, { stdio: 'inherit' });
  tsup.on('exit', (tsupCode) => {
    if (tsupCode === 0) {
      console.log(pc.green('[EFC] Build complete → dist/'));
    } else {
      process.exit(tsupCode ?? 1);
    }
  });
}
