import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import pc from 'picocolors';
import {
  Registry,
  applyAdd,
  detectProject,
  envFromAnswers,
  itemStatus,
  normalizeAnswer,
  promptApplies,
  promptDefault,
  lineDiff,
  planAdd,
  readEfcJson,
  variantOf,
  writeEfcJson,
  EFC_JSON,
  type AddPlan,
  type EfcJson,
  type ItemPrompt,
  type PromptAnswers,
} from '../registry.js';

export function registryCommands(): Command[] {
  return [initCommand(), addCommand(), listCommand(), viewCommand(), diffCommand()];
}

function fail(err: unknown): never {
  console.error(pc.red(`[EFC] ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}

function load(): { cwd: string; registry: Registry; cfg: EfcJson; detected: boolean } {
  const cwd = process.cwd();
  const registry = new Registry();
  const existing = readEfcJson(cwd);
  return {
    cwd,
    registry,
    cfg: existing ?? detectProject(cwd, registry.index.version),
    detected: !existing,
  };
}

function describe(cfg: EfcJson): string {
  const tasks = cfg.tasks ?? 'no task backend';
  return `${cfg.language}, ${cfg.database}${cfg.database === 'postgresql' ? ` (${cfg.modelApi})` : ''}, ${tasks}`;
}

function initCommand(): Command {
  return new Command('init')
    .description(`Write ${EFC_JSON} for an existing app (detects language, database and tasks)`)
    .option('--force', `replace an existing ${EFC_JSON}`)
    .action((opts: { force?: boolean }) => {
      try {
        const cwd = process.cwd();
        if (readEfcJson(cwd) && !opts.force) {
          console.log(pc.yellow(`${EFC_JSON} already exists (--force to redetect).`));
          return;
        }
        const registry = new Registry();
        const cfg = detectProject(cwd, registry.index.version);
        writeEfcJson(cwd, cfg);
        console.log(pc.green(`  created  ${EFC_JSON}`) + pc.dim(`  (${describe(cfg)})`));
        console.log(
          pc.dim(
            '  Check the values, then add features with `efc add <item>` — `efc list` shows them.',
          ),
        );
      } catch (err) {
        fail(err);
      }
    });
}

const ACTION_LABEL: Record<string, string> = {
  create: pc.green('create   '),
  update: pc.cyan('update   '),
  overwrite: pc.yellow('overwrite'),
  'skip-identical': pc.dim('identical'),
  conflict: pc.red('conflict '),
};

function printPlan(plan: AddPlan): void {
  console.log(pc.bold(`\n  Adding ${plan.items.join(', ')}`) + pc.dim(`  (${plan.variant})\n`));
  for (const f of plan.files) console.log(`  ${ACTION_LABEL[f.action]}  ${f.path}`);
  const deps = Object.entries(plan.dependencies);
  const devDeps = Object.entries(plan.devDependencies);
  if (deps.length || devDeps.length) {
    console.log(pc.bold('\n  Packages'));
    for (const [n, r] of deps) console.log(`  ${pc.green('+')} ${n}@${r}`);
    for (const [n, r] of devDeps) console.log(`  ${pc.green('+')} ${n}@${r} ${pc.dim('(dev)')}`);
  }
  if (plan.env.length) {
    console.log(pc.bold('\n  Environment') + pc.dim('  (.env / .env.example)'));
    for (const v of plan.env) console.log(`  ${pc.green('+')} ${v.key}`);
  }
  const conflicts = plan.files.filter((f) => f.action === 'conflict');
  if (conflicts.length) {
    console.log(
      pc.yellow(
        `\n  ${conflicts.length} file(s) differ from the registry and were changed in this app — they'll be left alone (--overwrite replaces them; \`efc diff\` shows the changes).`,
      ),
    );
  }
  console.log();
}

/**
 * One readline session for the whole command (confirmation + questions). Lines are queued:
 * input that arrives ahead of its question (pasted, piped) is kept for it, not dropped.
 */
interface Terminal {
  /** Asks and resolves with the next line; `hidden` doesn't echo it (passwords). */
  ask(question: string, hidden?: boolean): Promise<string>;
  close(): void;
}

function openTerminal(): Terminal {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, cb) {
      if (!muted) process.stdout.write(chunk, encoding);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next(undefined);
  });
  return {
    async ask(question, hidden = false) {
      if (hidden) {
        process.stdout.write(question);
        rl.setPrompt('');
        muted = true;
      } else {
        rl.setPrompt(question);
        rl.prompt();
      }
      try {
        const line =
          lines.length > 0
            ? lines.shift()
            : closed
              ? undefined
              : await new Promise<string | undefined>((resolve) => waiting.push(resolve));
        if (line === undefined) throw new Error('Aborted — no more input');
        return line;
      } finally {
        if (hidden) {
          muted = false;
          process.stdout.write('\n');
        }
      }
    },
    close: () => rl.close(),
  };
}

async function confirm(term: Terminal, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await term.ask(question)).trim());
}

/** Asks the plan's questions in the terminal (passwords hidden, wrong answers re-asked). */
async function askPrompts(
  term: Terminal,
  prompts: ItemPrompt[],
  cwd: string,
): Promise<PromptAnswers> {
  const answers: PromptAnswers = {};
  {
    for (const p of prompts) {
      if (!promptApplies(p, answers)) continue;
      if (p.note) console.log(pc.dim(`\n  ${p.note}`));
      if (p.type === 'select') {
        const options = p.options ?? [];
        console.log(`  ${p.message}`);
        options.forEach((o, i) =>
          console.log(
            `    ${pc.cyan(String(i + 1))}) ${o.label}${o.hint ? pc.dim(`  ${o.hint}`) : ''}`,
          ),
        );
        for (;;) {
          const raw = (await term.ask(`  Choose 1-${options.length} ${pc.dim('(1)')}: `)).trim();
          const chosen = options[raw === '' ? 0 : Number(raw) - 1];
          if (chosen) {
            answers[p.name] = chosen.value;
            break;
          }
        }
        continue;
      }
      const def = promptDefault(p, answers);
      const hint = def
        ? pc.dim(` (${def})`)
        : p.placeholder
          ? pc.dim(` e.g. ${p.placeholder}`)
          : '';
      for (;;) {
        const raw =
          p.type === 'password'
            ? await term.ask(`  ${p.message} `, true)
            : await term.ask(`  ${p.message}${hint} `);
        const r = normalizeAnswer(p, raw.trim() === '' ? (def ?? '') : raw, cwd);
        if ('error' in r) {
          console.log(pc.red(`  ${r.error}`));
          continue;
        }
        answers[p.name] = r.value;
        break;
      }
    }
  }
  return answers;
}

function packageManager(cwd: string): string {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock')))
    return 'bun';
  return 'npm';
}

function addCommand(): Command {
  return new Command('add')
    .description('Add features to the app from the registry (copies their source into src/)')
    .argument(
      '<items...>',
      'registry items, e.g. auth forgot-password admin-users — `efc list` shows them',
    )
    .option('-y, --yes', 'skip the confirmation')
    .option('--overwrite', 'replace files that were changed in this app')
    .option('--dry-run', 'show what would change without writing anything')
    .option('--no-install', "don't run the package manager afterwards")
    .option('--no-prompt', "don't ask for credentials — write placeholders to .env instead")
    .action(
      async (
        names: string[],
        opts: {
          yes?: boolean;
          overwrite?: boolean;
          dryRun?: boolean;
          install: boolean;
          prompt: boolean;
        },
      ) => {
        try {
          const { cwd, registry, cfg, detected } = load();
          const plan = planAdd(cwd, registry, names, { overwrite: !!opts.overwrite }, cfg);
          if (plan.problems.length) fail(plan.problems.join('\n'));
          if (plan.items.length === 0) {
            console.log(pc.dim(`Already installed: ${names.join(', ')}`));
            return;
          }
          if (detected) {
            console.log(
              pc.dim(`\n  No ${EFC_JSON} yet — detected ${describe(cfg)}; it'll be created.`),
            );
          }
          printPlan(plan);
          if (opts.dryRun) return;
          // Credentials etc. go straight into .env. Without a terminal (CI, agents) or with
          // --no-prompt, the vars get placeholders to fill in by hand.
          const tty = !!process.stdin.isTTY;
          if (!opts.yes && !tty) fail('Not a terminal — pass --yes to add without confirming.');
          const ask = opts.prompt && tty && plan.prompts.length > 0;
          let env: Record<string, string> = {};
          if (!opts.yes || ask) {
            const term = openTerminal();
            try {
              if (!opts.yes && !(await confirm(term, '  Proceed? (y/N) '))) {
                console.log(pc.dim('  Nothing changed.'));
                return;
              }
              if (ask) {
                console.log(pc.bold('\n  Configuration') + pc.dim('  (saved to .env)\n'));
                env = envFromAnswers(plan.prompts, await askPrompts(term, plan.prompts, cwd));
                console.log();
              }
            } finally {
              term.close();
            }
          }

          const result = applyAdd(cwd, plan, registry, env);
          console.log(
            pc.green(`  ✓ ${result.written.length} file(s) written`) +
              (result.conflicts.length ? pc.yellow(`, ${result.conflicts.length} left alone`) : ''),
          );
          for (const m of result.manual) console.log(pc.yellow(`  ! ${m}`));

          if (result.installNeeded) {
            const pm = packageManager(cwd);
            if (opts.install) {
              console.log(pc.dim(`  $ ${pm} install`));
              const r = spawnSync(pm, ['install'], {
                cwd,
                stdio: 'inherit',
                shell: process.platform === 'win32',
              });
              if (r.status !== 0)
                console.log(pc.yellow(`  ${pm} install failed — run it yourself.`));
            } else {
              console.log(pc.yellow(`  Run \`${pm} install\` for the new packages.`));
            }
          }
          const unset = plan.env.filter((v) => !(v.key in env)).map((v) => v.key);
          if (unset.length) {
            console.log(
              pc.yellow(
                `  Added ${unset.join(', ')} to .env with placeholder values — fill them in.`,
              ),
            );
          }
          for (const d of plan.docs) console.log(`  ${pc.bold(d.item)}: ${d.text}`);
          if (plan.files.some((f) => f.path.startsWith('src/model/'))) {
            console.log(
              pc.dim(
                '  New tables/collections are created on first use (autoSync); with autoSync: false, run `efc db sync`.',
              ),
            );
          }
          console.log();
        } catch (err) {
          fail(err);
        }
      },
    );
}

function listCommand(): Command {
  return new Command('list').description('List the features `efc add` can install').action(() => {
    try {
      const cwd = process.cwd();
      const registry = new Registry();
      const installed = new Set(readEfcJson(cwd)?.items ?? []);
      const groups = [...new Set(registry.index.items.map((i) => i.group))];
      for (const group of groups) {
        console.log(pc.bold(`\n  ${group}`));
        for (const item of registry.index.items.filter((i) => i.group === group)) {
          const mark = installed.has(item.name) ? pc.green('✓') : ' ';
          const deps = item.registryDependencies.length
            ? pc.dim(` (needs ${item.registryDependencies.join(', ')})`)
            : '';
          console.log(`  ${mark} ${pc.cyan(item.name.padEnd(20))} ${item.description}${deps}`);
        }
      }
      console.log(pc.dim('\n  efc add <item...>   ·   efc view <item>\n'));
    } catch (err) {
      fail(err);
    }
  });
}

function viewCommand(): Command {
  return new Command('view')
    .description("Print an item's files for this app's language and database")
    .argument('<item>')
    .option('--json', 'print the registry item as JSON')
    .action((name: string, opts: { json?: boolean }) => {
      try {
        const { registry, cfg } = load();
        const variant = variantOf(cfg);
        const meta = registry.meta(name);
        const item = registry.item(variant, name);
        if (opts.json) {
          console.log(JSON.stringify({ ...meta, ...item, variant }, null, 2));
          return;
        }
        console.log(pc.bold(`\n  ${meta.title}`) + pc.dim(` — ${meta.description} (${variant})`));
        if (meta.registryDependencies.length)
          console.log(pc.dim(`  needs: ${meta.registryDependencies.join(', ')}`));
        for (const f of item.files) {
          console.log(pc.cyan(`\n── ${f.path} ${'─'.repeat(Math.max(0, 60 - f.path.length))}`));
          console.log(f.content);
        }
      } catch (err) {
        fail(err);
      }
    });
}

function diffCommand(): Command {
  return new Command('diff')
    .description(
      'Compare installed features with the registry (local changes and available updates)',
    )
    .argument('[item]')
    .action((name: string | undefined) => {
      try {
        const cwd = process.cwd();
        const registry = new Registry();
        const cfg = readEfcJson(cwd);
        if (!cfg)
          fail(`No ${EFC_JSON} — nothing was added with efc yet (\`efc init\` creates one).`);
        const names = name ? [name] : cfg.items;
        let clean = true;
        for (const n of names) {
          for (const f of itemStatus(cwd, registry, cfg, n)) {
            if (f.status === 'unchanged') continue;
            clean = false;
            const label =
              f.status === 'missing'
                ? pc.red('missing')
                : f.status === 'modified'
                  ? pc.yellow('changed in app')
                  : f.status === 'outdated'
                    ? pc.cyan('update available')
                    : pc.magenta('update available + changed in app');
            console.log(`\n${pc.bold(n)}  ${f.path}  ${label}`);
            if (f.local !== undefined) {
              for (const line of lineDiff(f.local, f.registry)) {
                console.log(
                  line.startsWith('+')
                    ? pc.green(line)
                    : line.startsWith('-')
                      ? pc.red(line)
                      : pc.dim(line),
                );
              }
            }
          }
        }
        if (clean) console.log(pc.green('Every installed feature matches the registry.'));
        else {
          console.log(
            pc.dim(
              '\n  (- this app, + registry)  ·  `efc add <item> --overwrite` takes the registry version',
            ),
          );
        }
      } catch (err) {
        fail(err);
      }
    });
}
