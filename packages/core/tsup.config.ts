import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'auth/index': 'src/auth/index.ts',
    'tasks/index': 'src/tasks/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/db-runner': 'src/cli/db-runner.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  target: 'node18',
  banner: {
    js: '',
  },

});
