/**
 * Prompt templates for common EFC workflows. Each one points the agent at the doc
 * pages that hold the answer, so replies come from the docs rather than memory.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const ask = (task: string, pages: string[]) => ({
  messages: [
    {
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `${task}\n\nBefore answering, call the efc tool get-rules, then read these pages with get-doc: ${pages.join(', ')}. Use only APIs those pages document; say so if something isn't supported.`,
      },
    },
  ],
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'efc-new-project',
    {
      title: 'New EFC project',
      description: 'Scaffold and start a new EFC app.',
      argsSchema: { projectName: z.string().describe('Project directory name') },
    },
    ({ projectName }) =>
      ask(
        `Walk me through creating an EFC project called "${projectName}": scaffolding, the generated structure, starting the dev server, and adding a first route.`,
        ['getting-started/index', 'getting-started/project-structure', 'cli/start'],
      ),
  );

  server.registerPrompt(
    'efc-route',
    {
      title: 'Implement a route',
      description: 'Implement an EFC route file with validation, auth and errors.',
      argsSchema: {
        resource: z.string().describe('Resource, e.g. "products"'),
        methods: z.string().describe('Comma-separated methods, e.g. "GET,POST"'),
      },
    },
    ({ resource, methods }) =>
      ask(
        `Implement EFC routes for "${resource}" supporting ${methods}: file placement under src/api, handlers, request validation, auth if needed, and HttpError responses.`,
        [
          'skills/routing-rules',
          'guides/validation',
          'guides/error-handling',
          'api-reference/auth',
        ],
      ),
  );

  server.registerPrompt(
    'efc-model',
    {
      title: 'Design a model',
      description: 'Define a database model and query it (MongoDB or PostgreSQL).',
      argsSchema: {
        entity: z.string().describe('What the model stores, e.g. "orders with line items"'),
      },
    },
    ({ entity }) =>
      ask(`Design an EFC model for ${entity}, with the queries and writes a typical API needs.`, [
        'guides/database',
        'guides/which-api',
        'api-reference/db',
        'api-reference/table',
        'guides/relations',
        'guides/migrations',
      ]),
  );

  server.registerPrompt(
    'efc-task',
    {
      title: 'Background task',
      description: 'Implement a background or scheduled task.',
      argsSchema: { taskName: z.string(), purpose: z.string().describe('What the task does') },
    },
    ({ taskName, purpose }) =>
      ask(
        `Implement the EFC background task "${taskName}" (${purpose}): the task file, enqueueing it, retries, and whether it needs a schedule or a worker thread.`,
        ['core-concepts/background-tasks', 'api-reference/tasks', 'skills/tasks-internals'],
      ),
  );

  server.registerPrompt(
    'efc-auth',
    {
      title: 'Authentication',
      description: 'Add login, logout, roles and session revocation.',
      argsSchema: {
        strategy: z.enum(['http-only', 'localStorage']).describe('Token delivery'),
      },
    },
    ({ strategy }) =>
      ask(
        `Add authentication to an EFC app using the "${strategy}" strategy: issuing tokens, protecting routes, roles, logout and revoking sessions.`,
        ['guides/authentication', 'api-reference/auth', 'guides/rbac', 'guides/caching'],
      ),
  );

  server.registerPrompt(
    'efc-debug',
    {
      title: 'Debug an EFC app',
      description: 'Diagnose a boot failure, missing route, or runtime error.',
      argsSchema: { problem: z.string().describe('What goes wrong, with the error text') },
    },
    ({ problem }) =>
      ask(`Help me diagnose this EFC problem: ${problem}`, [
        'skills/pre-flight',
        'cli/diagnostics',
        'guides/error-handling',
        'guides/logging',
      ]),
  );

  server.registerPrompt(
    'efc-migrate-express',
    {
      title: 'Migrate from Express',
      description: 'Move an existing Express app onto EFC.',
      argsSchema: { notes: z.string().optional().describe('Anything notable about the app') },
    },
    ({ notes }) =>
      ask(
        `Plan a migration of an existing Express app to EFC${notes ? ` (${notes})` : ''}: routes to files, middleware tiers, auth, database models, background jobs, deployment.`,
        [
          'core-concepts/file-based-routing',
          'core-concepts/middleware',
          'api-reference/ignite',
          'guides/deployment',
        ],
      ),
  );
}
