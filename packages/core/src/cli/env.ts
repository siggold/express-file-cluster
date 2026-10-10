import fs from 'node:fs';
import path from 'node:path';

// Standalone CLI invocations (`efc doctor`, `efc tasks failed`, `efc db ...`) run before
// anything has loaded .env into process.env — that only happens inside `efc start dev`'s
// spawned child. Parse .env directly so vars that only live there are still seen.
export function readEnvFile(cwd: string = process.cwd()): Record<string, string> {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    vars[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

/** process.env wins over .env, matching how the dev server resolves them. */
export function envVar(key: string, cwd: string = process.cwd()): string | undefined {
  return process.env[key] || readEnvFile(cwd)[key] || undefined;
}
