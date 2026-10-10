import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

export function generateCommand(): Command {
  const cmd = new Command('generate').alias('g').description('Scaffold EFC modules');

  cmd
    .command('route <routePath>')
    .description('Scaffold a route module, e.g. users/[id]')
    .action((routePath: string) => generateRoute(routePath));

  cmd
    .command('task <name>')
    .description('Scaffold a background task module')
    .action((name: string) => generateTask(name));

  cmd
    .command('middleware <name>')
    .description('Scaffold a middleware module')
    .action((name: string) => generateMiddleware(name));

  cmd
    .command('migration <name>')
    .description('Scaffold a timestamped migration in src/migrations')
    .action((name: string) => generateMigration(name));

  cmd
    .command('seed <name>')
    .description('Scaffold a seed script in src/seeds')
    .action((name: string) => generateSeed(name));

  return cmd;
}

function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    console.error(pc.red(`File already exists: ${filePath}`));
    process.exit(1);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(pc.green(`  created  ${path.relative(process.cwd(), filePath)}`));
}

function generateRoute(routePath: string): void {
  const cwd = process.cwd();
  const filePath = path.join(cwd, 'src', 'api', `${routePath}.ts`);
  const content = `import type { Request, Response } from 'express';
import type { RouteMeta } from 'express-file-cluster';

export const meta: RouteMeta = {
  GET: {
    description: 'TODO: describe this endpoint.',
    request: {
      headers: {
        // 'Content-Type': 'application/json'
      },
      query: {
        // search: 'query'
      },
    },
    response: {
      status: 200,
      body: {
        message: 'OK'
      }
    }
  },
  POST: {
    description: 'TODO: describe this endpoint.',
    request: {
      body: {
        // name: 'string'
      }
    },
    response: {
      status: 201,
      body: {
        message: 'Created'
      }
    }
  }
};

export const GET = async (req: Request, res: Response) => {
  res.json({ message: 'OK' });
};

export const POST = async (req: Request, res: Response) => {
  res.status(201).json({ message: 'Created' });
};
`;

  writeFile(filePath, content);
  console.log(pc.cyan(`[EFC] Route scaffolded`));
}

function generateTask(name: string): void {
  const cwd = process.cwd();
  const filePath = path.join(cwd, 'src', 'tasks', `${name}.ts`);

  const content = `import { defineTask } from 'express-file-cluster/tasks';

interface ${name}Payload {
  // TODO: define payload fields
}

export default defineTask<${name}Payload>(async (payload) => {
  // TODO: implement task logic
  console.log('[Task:${name}]', payload);
});
`;

  writeFile(filePath, content);
  console.log(pc.cyan(`[EFC] Task scaffolded`));
}

function generateMiddleware(name: string): void {
  const cwd = process.cwd();
  const filePath = path.join(cwd, 'src', 'middlewares', `${name}.ts`);

  const content = `import type { Request, Response, NextFunction } from 'express';

export function ${name}(req: Request, res: Response, next: NextFunction): void {
  // TODO: implement middleware logic
  next();
}
`;

  writeFile(filePath, content);
  console.log(pc.cyan(`[EFC] Middleware scaffolded`));
}

const isTypeScript = () => fs.existsSync(path.join(process.cwd(), 'tsconfig.json'));
const snake = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();

function generateMigration(name: string): void {
  // UTC timestamp prefix keeps files sorted in creation order.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ts = isTypeScript();
  const filePath = path.join(
    process.cwd(),
    'src',
    'migrations',
    `${stamp}_${snake(name)}.${ts ? 'ts' : 'js'}`,
  );
  const typeImport = ts ? "import type { MigrationContext } from 'express-file-cluster';\n" : '';
  const ctx = ts ? '{ db, engine }: MigrationContext' : '{ db, engine }';
  const ret = ts ? ': Promise<void>' : '';
  writeFile(
    filePath,
    `${typeImport}// import { User } from '../model/User.js';

// \`efc db migrate\` runs up(); \`efc db rollback\` runs down(). \`db\` is the native client:
// a mongoose Connection on MongoDB, a node-postgres Pool on PostgreSQL.
export async function up(${ctx})${ret} {
  // await User.sync(); // create the table/collection, new columns and indexes
}

export async function down(${ctx})${ret} {
  // if (engine === 'postgresql') await db.query('DROP TABLE IF EXISTS users');
}
`,
  );
  console.log(pc.cyan('[EFC] Migration scaffolded — run `efc db migrate`'));
}

function generateSeed(name: string): void {
  const ts = isTypeScript();
  const filePath = path.join(process.cwd(), 'src', 'seeds', `${snake(name)}.${ts ? 'ts' : 'js'}`);
  const typeImport = ts ? "import type { MigrationContext } from 'express-file-cluster';\n" : '';
  const ctx = ts ? '{ engine }: MigrationContext' : '{ engine }';
  writeFile(
    filePath,
    `${typeImport}// import { User } from '../model/User.js';

// Run with \`efc db seed\` (all seeds) or \`efc db seed ${snake(name)}\`.
export default async function seed(${ctx}) {
  // await User.createMany([{ name: 'Ada', email: 'ada@example.com' }]);
}
`,
  );
  console.log(pc.cyan('[EFC] Seed scaffolded — run `efc db seed`'));
}
