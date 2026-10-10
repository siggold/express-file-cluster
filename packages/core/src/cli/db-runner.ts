// Child process behind `efc db ...`. The CLI spawns it under tsx (so TypeScript
// migrations, seeds and the models they import load straight from src/) or plain
// node against dist/src. Running it in the project's own module graph means models
// defined in migrations share state with this package — engine, connection, registry.
import pc from 'picocolors';
import type { DatabaseEngine } from '../types.js';
import { setDbEngine } from '../db/engine.js';
import { setDbClient } from '../db/index.js';
import { connectMongo } from '../db/mongo.js';
import { connectPostgres, closePostgres } from '../db/postgres.js';
import { Migrator, runSeeds } from '../db/migrator.js';
import { startStudio } from '../db/studio.js';
import { configureLogger } from '../logger.js';
import path from 'node:path';

interface RunnerOptions {
  root: string;
  databaseUrl?: string;
  steps?: number;
  seed?: string;
  port?: number;
}

function engineOf(url: string): DatabaseEngine {
  if (url.startsWith('mongodb')) return 'mongodb';
  if (url.startsWith('postgres')) return 'postgresql';
  throw new Error(`[EFC] Unsupported DATABASE_URL scheme: ${url.split(':')[0]}`);
}

async function main(): Promise<void> {
  const [command, raw] = process.argv.slice(2);
  const opts = JSON.parse(raw ?? '{}') as RunnerOptions;
  configureLogger({ level: 'warn' });

  const url = opts.databaseUrl ?? process.env['DATABASE_URL'];
  if (!url)
    throw new Error('[EFC] DATABASE_URL is not set (add it to .env or pass --database-url)');
  const engine = engineOf(url);
  setDbEngine(engine);
  const client: unknown =
    engine === 'mongodb' ? await connectMongo(url) : await connectPostgres(url);
  setDbClient(client as Record<string, unknown>);

  const close = async () => {
    if (engine === 'mongodb') await (client as { close: () => Promise<void> }).close();
    else await closePostgres();
  };

  const migrations = path.join(opts.root, 'migrations');
  const step = (verb: string) => (name: string) => console.log(`  ${pc.cyan(verb)} ${name}`);

  try {
    switch (command) {
      case 'migrate': {
        const ran = await new Migrator(migrations, engine, client).migrate({ onRun: step('up  ') });
        console.log(
          ran.length
            ? pc.green(`\n  Ran ${ran.length} migration(s)\n`)
            : pc.green('  Nothing to migrate'),
        );
        break;
      }
      case 'rollback': {
        const done = await new Migrator(migrations, engine, client).rollback({
          ...(opts.steps !== undefined && { steps: opts.steps }),
          onRun: step('down'),
        });
        console.log(
          done.length
            ? pc.green(`\n  Rolled back ${done.length} migration(s)\n`)
            : pc.green('  Nothing to roll back'),
        );
        break;
      }
      case 'status': {
        const rows = await new Migrator(migrations, engine, client).status();
        console.log(pc.bold(`\n  Migrations ${pc.dim(`(${engine})`)}\n`));
        if (rows.length === 0)
          console.log(pc.dim(`  none in ${path.relative(process.cwd(), migrations)}`));
        for (const r of rows) {
          console.log(
            r.batch !== undefined
              ? `  ${pc.green('✓')} ${r.name} ${pc.dim(`batch ${r.batch}`)}`
              : `  ${pc.yellow('•')} ${r.name} ${pc.dim('pending')}`,
          );
        }
        console.log();
        break;
      }
      case 'seed': {
        const ran = await runSeeds(
          path.join(opts.root, 'seeds'),
          engine,
          client,
          opts.seed,
          step('seed'),
        );
        console.log(pc.green(`\n  Ran ${ran.length} seed(s)\n`));
        break;
      }
      case 'studio': {
        const { url: studioUrl } = await startStudio(engine, client, opts.port ?? 4983);
        console.log(
          `\n  ${pc.bold('EFC Studio')} ${pc.dim(`(${engine}, read-only)`)}  ${pc.cyan(studioUrl)}\n`,
        );
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        break;
      }
      default:
        throw new Error(`[EFC] Unknown db command: ${command}`);
    }
  } finally {
    // Never let a failed disconnect mask the error that actually stopped the command.
    await close().catch((err: unknown) =>
      console.error(pc.dim(`(disconnect failed: ${String(err)})`)),
    );
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    // Full stack on request — a failing migration's line number is usually what you need.
    if (process.env['EFC_DEBUG'] && err instanceof Error) console.error(pc.dim(err.stack ?? ''));
    process.exit(1);
  },
);
