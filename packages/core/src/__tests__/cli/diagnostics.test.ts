import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsCommands } from '../../cli/commands/diagnostics.js';

describe('efc tasks', () => {
  let cwd: string;
  let tasksDir: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'efc-diagnostics-'));
    tasksDir = path.join(cwd, 'src', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function listTasks(): Promise<string[]> {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await diagnosticsCommands()
      .find((command) => command.name() === 'tasks')!
      .parseAsync([], {
        from: 'user',
      });
    return log.mock.calls.map(([line]) => String(line ?? '').trim()).filter(Boolean);
  }

  it('finds a project with only an .mjs task without importing it', async () => {
    const sideEffect = path.join(cwd, 'executed');
    fs.writeFileSync(
      path.join(tasksDir, 'SendEmail.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sideEffect)}, 'ran');`,
    );

    expect(await listTasks()).toEqual(['Background Tasks', 'SendEmail']);
    expect(fs.existsSync(sideEffect)).toBe(false);
  });

  it('lists all supported extensions and excludes directories and unrelated files', async () => {
    for (const filename of ['TsTask.ts', 'JsTask.js', 'MtsTask.mts', 'MjsTask.mjs', 'notes.txt']) {
      fs.writeFileSync(path.join(tasksDir, filename), '');
    }
    fs.mkdirSync(path.join(tasksDir, 'nested.js'));
    fs.writeFileSync(path.join(tasksDir, 'nested.js', 'Hidden.ts'), '');

    const [heading, ...names] = await listTasks();
    expect(heading).toBe('Background Tasks');
    expect(names.sort()).toEqual(['JsTask', 'MjsTask', 'MtsTask', 'TsTask']);
  });
});
