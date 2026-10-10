import { Command } from 'commander';
import pc from 'picocolors';
import { envVar } from '../env.js';
import { bullmqAdmin, type TaskAdmin } from '../../tasks/admin.js';

interface AdminOpts {
  backend?: string;
  queue: string;
  redisUrl?: string;
  databaseUrl?: string;
}

function withConnectionOptions(cmd: Command): Command {
  return cmd
    .option(
      '--backend <backend>',
      'bullmq | pg-boss (default: inferred from REDIS_URL / DATABASE_URL)',
    )
    .option('--queue <name>', 'queue name (tasks.queue in ignite())', 'efc')
    .option('--redis-url <url>', 'Redis URL for BullMQ (default: REDIS_URL)')
    .option('--database-url <url>', 'Postgres URL for pg-boss (default: DATABASE_URL)');
}

async function connect(opts: AdminOpts): Promise<TaskAdmin> {
  const redisUrl = opts.redisUrl ?? envVar('REDIS_URL');
  const databaseUrl = opts.databaseUrl ?? envVar('DATABASE_URL');
  const backend =
    opts.backend ??
    (redisUrl ? 'bullmq' : databaseUrl?.startsWith('postgres') ? 'pg-boss' : 'bullmq');

  if (backend === 'bullmq') return bullmqAdmin(redisUrl ?? 'redis://localhost:6379', opts.queue);
  if (backend === 'pg-boss')
    throw new Error('[EFC] pg-boss dead-letter inspection is not wired yet');
  throw new Error(`[EFC] Unknown task backend: ${backend}`);
}

async function run(opts: AdminOpts, fn: (admin: TaskAdmin) => Promise<void>): Promise<void> {
  let admin: TaskAdmin | undefined;
  try {
    admin = await connect(opts);
    await fn(admin);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  } finally {
    await admin?.close().catch(() => {});
  }
}

function ids(list: string[], all: boolean | undefined): string[] | null {
  if (all) return [];
  if (list.length === 0) {
    console.error(pc.red('Pass job ids, or --all'));
    process.exitCode = 1;
    return null;
  }
  return list;
}

export function taskAdminCommands(): Command[] {
  const failed = withConnectionOptions(
    new Command('failed').description('List jobs that exhausted their retries (dead-lettered)'),
  )
    .option('-n, --limit <n>', 'max jobs to show', '20')
    .option('--name <task>', 'only this task')
    .option('--json', 'print JSON')
    .action((opts: AdminOpts & { limit: string; name?: string; json?: boolean }) =>
      run(opts, async (admin) => {
        const jobs = await admin.listFailed({
          limit: Number(opts.limit),
          ...(opts.name !== undefined && { name: opts.name }),
        });
        if (opts.json) {
          console.log(JSON.stringify(jobs, null, 2));
          return;
        }
        const counts = await admin.counts();
        console.log(
          pc.bold('\n  Queue ') +
            pc.dim(
              Object.entries(counts)
                .map(([k, v]) => `${k}=${v}`)
                .join('  '),
            ) +
            '\n',
        );
        if (jobs.length === 0) {
          console.log(pc.green('  No failed jobs.\n'));
          return;
        }
        for (const job of jobs) {
          console.log(
            `  ${pc.red('✗')} ${pc.cyan(job.name)} ${pc.dim('#' + job.id)}  ` +
              pc.dim(
                `attempts=${job.attempts}${job.failedAt ? '  ' + job.failedAt.toISOString() : ''}`,
              ),
          );
          console.log(`    ${job.error}`);
          console.log(pc.dim(`    data: ${JSON.stringify(job.data)}`));
        }
        console.log();
      }),
    );

  const retry = withConnectionOptions(
    new Command('retry').description('Re-queue failed jobs').argument('[ids...]', 'job ids'),
  )
    .option('--all', 'retry every failed job')
    .action((list: string[], opts: AdminOpts & { all?: boolean }) => {
      const selected = ids(list, opts.all);
      if (!selected) return;
      return run(opts, async (admin) => {
        console.log(pc.green(`Retried ${await admin.retry(selected)} job(s)`));
      });
    });

  const purge = withConnectionOptions(
    new Command('purge').description('Delete failed jobs').argument('[ids...]', 'job ids'),
  )
    .option('--all', 'delete every failed job')
    .action((list: string[], opts: AdminOpts & { all?: boolean }) => {
      const selected = ids(list, opts.all);
      if (!selected) return;
      return run(opts, async (admin) => {
        console.log(pc.green(`Removed ${await admin.purge(selected)} job(s)`));
      });
    });

  return [failed, retry, purge];
}
