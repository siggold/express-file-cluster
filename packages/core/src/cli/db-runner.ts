// Child process behind `efc db ...`. The CLI spawns it under tsx (so TypeScript
// migrations, seeds and the models they import load straight from src/) or plain
// node against dist/src. Running it in the project's own module graph means models
// defined in migrations share state with this package — engine, connection, registry.
import pc from 'picocolors';
import type { Pool } from 'pg';
import type { DatabaseEngine } from '../types.js';
import { setDbEngine } from '../db/engine.js';
import { setDbClient } from '../db/index.js';
import { connectMongo } from '../db/mongo.js';
import { connectPostgres, closePostgres } from '../db/postgres.js';
import { Migrator, runSeeds } from '../db/migrator.js';
import { startStudio } from '../db/studio.js';
import { configureLogger } from '../logger.js';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registeredModels, setAutoSync, setSyncSuppressed, type PlanStep } from '../db/engine.js';
import { describeStep, planModels, renderMigration } from '../db/generate.js';
import { pullPostgres } from '../db/pull.js';
import { writeModels } from '../db/codegen.js';

interface RunnerOptions {
  root: string;
  databaseUrl?: string;
  dryRun?: boolean;
  exitCode?: boolean;
  baseline?: boolean;
  name?: string;
  verify?: boolean;
  allowDrop?: boolean;
  tighten?: boolean;
  out?: string;
  force?: boolean;
  steps?: number;
  seed?: string;
  port?: number;
}

// Every model lives in src/model(s)/ by convention; importing the files registers them.
async function importModels(root: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|js|mts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
        files.push(p);
    }
  };
  walk(path.join(root, 'model'));
  walk(path.join(root, 'models'));
  for (const f of files.sort()) await import(pathToFileURL(f).href);
  return registeredModels();
}

/** The same server, a throwaway PostgreSQL schema (via search_path) or MongoDB database. */
function shadowUrl(url: string, engine: DatabaseEngine, name: string): string {
  if (engine === 'mongodb')
    return url.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?/, `$1/${name}`);
  const u = new URL(url);
  const prev = u.searchParams.get('options');
  u.searchParams.set('options', `${prev ? `${prev} ` : ''}-c search_path=${name}`);
  return u.toString();
}

// MongoDB: document renames can't be seen in an empty shadow database — leave out the
// ones a migration file already carries.
function withoutWrittenRenames(steps: PlanStep[]): PlanStep[] {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  if (!steps.some((st) => st.sql.includes('$rename')) || !fs.existsSync(dir)) return steps;
  const written = fs
    .readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
  return steps.filter((st) => !(st.sql.includes('$rename') && written.includes(st.sql)));
}

const migrationStamp = (d = new Date()) => d.toISOString().replace(/\D/g, '').slice(0, 14);

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
  let client: unknown = engine === 'mongodb' ? await connectMongo(url) : await connectPostgres(url);
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
        const ran = await new Migrator(migrations, engine, client).migrate({
          onRun: step(opts.baseline ? 'mark' : 'up  '),
          ...(opts.baseline && { baseline: true }),
        });
        console.log(
          ran.length
            ? pc.green(
                `\n  ${opts.baseline ? 'Marked' : 'Ran'} ${ran.length} migration(s)${opts.baseline ? ' as applied' : ''}\n`,
              )
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
      case 'sync': {
        setAutoSync(false); // report/apply only what this command decides
        const models = await importModels(opts.root);
        if (models.length === 0) {
          console.log(
            pc.yellow(`  No models found in ${path.relative(process.cwd(), opts.root)}/model(s)/`),
          );
          break;
        }
        let total = 0;
        for (const model of models) {
          const changes = await model.sync({ dryRun: Boolean(opts.dryRun) });
          total += changes.length;
          console.log(
            `  ${changes.length ? pc.cyan('●') : pc.green('✓')} ${model.name} ${pc.dim(changes.length ? `${changes.length} change(s)` : 'in sync')}`,
          );
          for (const c of changes) console.log(pc.dim(`      ${c.replace(/\n\s*/g, ' ')}`));
        }
        console.log(
          total === 0
            ? pc.green('\n  Everything in sync\n')
            : opts.dryRun
              ? pc.yellow(`\n  ${total} pending change(s) — run without --dry-run to apply\n`)
              : pc.green(`\n  Applied ${total} change(s)\n`),
        );
        // CI drift check: 2 = the database differs from the models (1 stays "error").
        if (opts.dryRun && opts.exitCode && total > 0) process.exitCode = 2;
        break;
      }
      case 'generate': {
        // Diff the models against the schema the migrations produce — replayed into a
        // throwaway schema/database — not against the dev database, which autoSync keeps
        // in step with the models already.
        const shadow = `efc_shadow_${process.pid}_${Date.now().toString(36)}`;
        if (engine === 'postgresql') {
          await (client as { query(s: string): Promise<unknown> }).query(
            `CREATE SCHEMA "${shadow}"`,
          );
        }
        await close();
        client =
          engine === 'mongodb'
            ? await connectMongo(shadowUrl(url, engine, shadow))
            : await connectPostgres(shadowUrl(url, engine, shadow));
        setDbClient(client as Record<string, unknown>);
        try {
          setAutoSync(false);
          const migrator = new Migrator(migrations, engine, client);
          setSyncSuppressed(true);
          try {
            await migrator.migrate();
          } finally {
            setSyncSuppressed(false);
          }
          const models = await importModels(opts.root);
          if (models.length === 0) {
            console.log(
              pc.yellow(
                `  No models found in ${path.relative(process.cwd(), opts.root)}/model(s)/`,
              ),
            );
            break;
          }
          const planOpts = {
            ...(opts.allowDrop && { allowDrop: true }),
            ...(opts.tighten && { tighten: true }),
          };
          let steps = await planModels(models, planOpts);
          steps = withoutWrittenRenames(steps);

          if (opts.name !== undefined) {
            if (steps.length === 0) {
              console.log(pc.green('  No changes — the migrations already match the models'));
            } else {
              const typescript = fs.existsSync(path.join(process.cwd(), 'tsconfig.json'));
              const slug =
                opts.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'migration';
              const dir = path.join(process.cwd(), 'src', 'migrations');
              const file = path.join(
                dir,
                `${migrationStamp()}_${slug}.${typescript ? 'ts' : 'js'}`,
              );
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(
                file,
                renderMigration({ engine, typescript, name: opts.name, steps }),
              );
              console.log(
                `\n  ${pc.green('Created')} ${path.relative(process.cwd(), file)} ${pc.dim(`(${steps.length} step(s))`)}\n`,
              );
              for (const st of steps) console.log(pc.dim(`    ${describeStep(st).slice(0, 160)}`));
              console.log(pc.dim('\n  Review it, then run efc db migrate\n'));
            }
          } else if (!opts.verify) {
            for (const st of steps) console.log(`  ${describeStep(st)}`);
            console.log(
              steps.length
                ? pc.yellow(
                    `\n  ${steps.length} step(s) — pass a name to write them as a migration\n`,
                  )
                : pc.green('  No changes — the migrations already match the models'),
            );
          }

          if (opts.verify) {
            // Replay everything (including a migration written just now) and require that
            // the result matches the models exactly.
            await migrator.migrate();
            const left = withoutWrittenRenames(await planModels(models));
            if (left.length === 0) {
              console.log(
                pc.green('  ✓ Verified: the migrations produce exactly the models’ schema'),
              );
            } else {
              console.log(
                pc.red(
                  `\n  ✗ The migrations don't match the models — ${left.length} step(s) missing:\n`,
                ),
              );
              for (const st of left) console.log(pc.dim(`    ${describeStep(st).slice(0, 160)}`));
              console.log(pc.dim('\n  Run efc db generate <name> to write them\n'));
              process.exitCode = 1;
            }
          }
        } finally {
          if (engine === 'postgresql') {
            await (client as { query(s: string): Promise<unknown> })
              .query(`DROP SCHEMA IF EXISTS "${shadow}" CASCADE`)
              .catch(() => {});
          } else {
            await (client as { dropDatabase(): Promise<unknown> }).dropDatabase().catch(() => {});
          }
        }
        break;
      }
      case 'pull': {
        if (engine !== 'postgresql')
          throw new Error(
            '[EFC] efc db pull reads PostgreSQL schemas (MongoDB arrives with defineCollection)',
          );
        const { models, skipped: notPulled } = await pullPostgres(client as Pool);
        if (models.length === 0) {
          console.log(pc.yellow('  No tables found in the current schema'));
          break;
        }
        const typescript = fs.existsSync(path.join(process.cwd(), 'tsconfig.json'));
        const dir = path.resolve(process.cwd(), opts.out ?? path.join('src', 'model'));
        const { written, skipped } = writeModels(dir, models, {
          typescript,
          ...(opts.force && { force: true }),
        });
        console.log(pc.bold(`\n  Pulled ${models.length} model(s)\n`));
        for (const f of written)
          console.log(`  ${pc.green('+')} ${path.relative(process.cwd(), f)}`);
        for (const f of skipped)
          console.log(
            `  ${pc.yellow('•')} ${path.relative(process.cwd(), f)} ${pc.dim('exists — kept (--force overwrites)')}`,
          );
        if (notPulled.length)
          console.log(
            pc.dim(
              `\n  Not pulled (no single "id" primary key of type uuid, integer or bigint): ${notPulled.join(', ')}`,
            ),
          );
        const notes = models.reduce((n, m) => n + m.notes.length, 0);
        if (notes)
          console.log(
            pc.dim(`\n  ${notes} note(s) about what couldn't be carried over are in the files`),
          );
        console.log();
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
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    // Full stack on request — a failing migration's line number is usually what you need.
    if (process.env['EFC_DEBUG'] && err instanceof Error) console.error(pc.dim(err.stack ?? ''));
    process.exit(1);
  },
);
