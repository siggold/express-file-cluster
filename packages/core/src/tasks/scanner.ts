import fs from 'node:fs';
import path from 'node:path';
import { registerTask } from './index.js';
import { getLogger } from '../logger.js';
import type { TaskDefinition } from '../types.js';

export async function scanTasks(tasksDir: string): Promise<void> {
  if (!fs.existsSync(tasksDir)) return;

  const files = fs.readdirSync(tasksDir).filter((f) => /\.(ts|js|mts|mjs)$/.test(f));

  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    const taskName = path.basename(file, path.extname(file));

    try {
      const mod = (await import(filePath)) as Record<string, unknown>;
      const def = mod['default'] as TaskDefinition | undefined;

      if (!def || typeof def.handler !== 'function') {
        getLogger().warn(`Task file ${file} has no valid default export — skipping`);
        continue;
      }

      registerTask(taskName, { ...def, filePath });
      getLogger().debug(`Registered task: ${taskName}`);
    } catch (err) {
      getLogger().warn({ err }, `Failed to load task ${file}`);
    }
  }
}
