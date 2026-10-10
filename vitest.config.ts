import { defineConfig } from 'vitest/config';

// `defineWorkspace` (the old vitest.workspace.ts API) was removed in Vitest 4 — it now
// fails to load silently and vitest falls back to scanning the whole repo, which is how
// stray dist/ build artifacts ended up running as tests. `test.projects` is the replacement.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'create-efc-app',
          root: './packages/create-efc-app',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
    ],
  },
});
