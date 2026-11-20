import fs from 'node:fs';
import path from 'node:path';

export function listTaskFiles(tasksDir: string): string[] {
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => {
      if (!/\.(ts|js|mts|mjs)$/.test(entry.name)) return false;
      if (entry.isFile()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(tasksDir, entry.name)).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
}
