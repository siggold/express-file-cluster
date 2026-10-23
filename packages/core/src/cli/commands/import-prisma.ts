import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { writeModels } from '../../db/codegen.js';
import { importPrisma } from '../../db/prisma-import.js';

export function importPrismaCommand(): Command {
  return new Command('import-prisma')
    .description('Write defineTable models from a Prisma schema (PostgreSQL)')
    .argument('[schema]', 'path to schema.prisma', 'prisma/schema.prisma')
    .option('--out <dir>', 'where to write the models', 'src/model')
    .option('--force', 'overwrite model files that already exist')
    .action((schema: string, opts: { out: string; force?: boolean }) => {
      const file = path.resolve(schema);
      if (!fs.existsSync(file)) {
        console.error(pc.red(`  ${schema} not found`));
        process.exit(1);
      }
      const { models, warnings } = importPrisma(fs.readFileSync(file, 'utf8'));
      const typescript = fs.existsSync(path.join(process.cwd(), 'tsconfig.json'));
      const dir = path.resolve(opts.out);
      const { written, skipped } = writeModels(dir, models, {
        typescript,
        ...(opts.force && { force: true }),
      });
      console.log(pc.bold(`\n  Imported ${models.length} model(s) from ${schema}\n`));
      for (const f of written) console.log(`  ${pc.green('+')} ${path.relative(process.cwd(), f)}`);
      for (const f of skipped)
        console.log(
          `  ${pc.yellow('•')} ${path.relative(process.cwd(), f)} ${pc.dim('exists — kept (--force overwrites)')}`,
        );
      for (const w of warnings) console.log(pc.yellow(`  ! ${w}`));
      const notes = models.reduce((n, m) => n + m.notes.length, 0);
      if (notes)
        console.log(
          pc.dim(`\n  ${notes} note(s) about what couldn't be carried over are in the files`),
        );
      console.log(
        pc.dim(
          '\n  Next: efc db generate --verify against your database, or efc db generate init on a new one\n',
        ),
      );
    });
}
