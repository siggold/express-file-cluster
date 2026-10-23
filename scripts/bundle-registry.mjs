#!/usr/bin/env node
// Renders the `efc add` feature registry into a package's build output:
//
//   node scripts/bundle-registry.mjs <dest>   → <dest>/registry/index.json
//                                               <dest>/registry/<variant>/<item>.json
//                                               <dest>/registry/<variant>/_base.json
//
// The items come from create-efc-app's templates (packages/create-efc-app/src/registry.ts),
// bundled here with esbuild so this doesn't depend on the workspaces' build order. Used by
// express-file-cluster (dist/registry — read by `efc add`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.argv[2];
if (!dest) {
  console.error('usage: bundle-registry.mjs <dest-dir>');
  process.exit(1);
}
const out = path.resolve(process.cwd(), dest, 'registry');

// Inside node_modules so the bundle's external imports (fs-extra) resolve from the repo.
const bundle = path.join(root, 'node_modules', '.cache', `efc-registry-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'packages', 'create-efc-app', 'src', 'registry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  outfile: bundle,
  logLevel: 'warning',
});

try {
  const { VARIANTS, renderVariant } = await import(pathToFileURL(bundle).href);
  const { version } = JSON.parse(
    fs.readFileSync(path.join(root, 'packages', 'core', 'package.json'), 'utf8'),
  );
  fs.rmSync(out, { recursive: true, force: true });
  let index;
  let count = 0;
  for (const v of VARIANTS) {
    const rendered = await renderVariant(v);
    index ??= rendered.index;
    const dir = path.join(out, v.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_base.json'), JSON.stringify({ files: rendered.base }));
    for (const item of rendered.items) {
      fs.writeFileSync(path.join(dir, `${item.name}.json`), JSON.stringify(item));
      count++;
    }
  }
  const variants = VARIANTS.map(({ key, language, database, modelApi }) => ({
    key,
    language,
    database,
    modelApi,
  }));
  fs.writeFileSync(
    path.join(out, 'index.json'),
    JSON.stringify({ version, variants, items: index }, null, 2),
  );
  console.log(
    `rendered ${index.length} registry items × ${VARIANTS.length} variants (${count} files) → ${path.relative(process.cwd(), out)}`,
  );
} finally {
  fs.rmSync(bundle, { force: true });
}
