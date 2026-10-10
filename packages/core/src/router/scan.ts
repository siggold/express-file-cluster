import fs from 'node:fs';
import path from 'node:path';
import type { RouteEntry } from '../types.js';

const ROUTE_FILE_RE = /\.(ts|js|mts|mjs|cts|cjs)$/;
const DYNAMIC_SEGMENT_RE = /\[([^\]]+)\]/g;

/** Maximum directory depth scanDir will recurse into by default. */
const DEFAULT_MAX_DEPTH = 10;

// Match order within one position: static, then [id], then [[id]], then [...slug],
// then [[...slug]]. Comparing these ranks segment by segment means a more specific
// route always registers (and so matches) first.
const enum Rank {
  Static = 0,
  Dynamic = 1,
  Optional = 2,
  CatchAll = 3,
  OptionalCatchAll = 4,
}

interface Segment {
  rank: Rank;
  /** Express-style display/path form: `users`, `:id`, `:id?`, `:slug*`, `:slug*?`. */
  display: string;
  name?: string;
}

function parseSegment(raw: string): Segment {
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^\[\[\.\.\.([^\]]+)\]\]$/)))
    return { rank: Rank.OptionalCatchAll, display: `:${m[1]}*?`, name: m[1]! };
  if ((m = raw.match(/^\[\.\.\.([^\]]+)\]$/)))
    return { rank: Rank.CatchAll, display: `:${m[1]}*`, name: m[1]! };
  if ((m = raw.match(/^\[\[([^\]]+)\]\]$/)))
    return { rank: Rank.Optional, display: `:${m[1]}?`, name: m[1]! };
  if (raw.includes('['))
    return { rank: Rank.Dynamic, display: raw.replace(DYNAMIC_SEGMENT_RE, ':$1') };
  return { rank: Rank.Static, display: raw };
}

function segmentsOf(relativePath: string): Segment[] {
  const p = relativePath.replace(ROUTE_FILE_RE, '').replace(/(^|\/)index$/, '');
  return p.split('/').filter(Boolean).map(parseSegment);
}

function filePathToUrlPath(relativePath: string): string {
  const segs = segmentsOf(relativePath);
  return segs.length === 0 ? '/' : '/' + segs.map((s) => s.display).join('/');
}

function extractParams(relativePath: string): string[] {
  const params: string[] = [];
  for (const raw of relativePath.split('/')) {
    const re = /\[+(?:\.\.\.)?([^\]]+)\]+/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      if (match[1]) params.push(match[1]);
    }
  }
  return params;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Express 4's string paths can't express a multi-segment catch-all with a name, so
 * routes containing one are mounted on a RegExp; captures come back in segment order
 * and mount.ts maps them onto the names in `params`.
 */
function buildPattern(segs: Segment[]): RegExp | undefined {
  const last = segs.length - 1;
  segs.forEach((s, i) => {
    if (i !== last && (s.rank === Rank.CatchAll || s.rank === Rank.OptionalCatchAll)) {
      throw new Error(`[EFC] Catch-all segment "${s.display}" must be the last path segment`);
    }
  });
  if (!segs.some((s) => s.rank >= Rank.CatchAll)) return undefined;

  let src = '';
  for (const s of segs) {
    switch (s.rank) {
      case Rank.Static:
        src += '/' + escapeRegExp(s.display);
        break;
      case Rank.Dynamic:
        src += '/' + escapeRegExp(s.display).replace(/:[A-Za-z0-9_$]+/g, '([^/]+?)');
        break;
      case Rank.Optional:
        src += '(?:/([^/]+?))?';
        break;
      case Rank.CatchAll:
        src += '/(.+?)';
        break;
      case Rank.OptionalCatchAll:
        src += '(?:/(.*?))?';
        break;
    }
  }
  return new RegExp(`^${src || ''}/?$`, 'i');
}

function compareSpecificity(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = a[i]!.rank - b[i]!.rank;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Recursively scans `dir` for route files and returns a sorted list of
 * `RouteEntry` objects, most specific first: at each path position a static
 * segment beats `[id]`, which beats `[[id]]`, then `[...slug]`, then
 * `[[...slug]]`. Ties are sorted alphabetically.
 *
 * @param dir      - Root directory to scan (must exist).
 * @param base     - Base directory used to derive relative URL paths; defaults to `dir`.
 * @param maxDepth - Maximum recursion depth (default: 10). Guards against
 *                   circular symlinks or unexpectedly deep directory trees.
 * @param _depth   - Internal current depth counter — do not pass externally.
 */
export function scanDir(
  dir: string,
  base: string = dir,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  _depth: number = 0,
): RouteEntry[] {
  if (!fs.existsSync(dir)) return [];
  if (_depth > maxDepth) {
    console.warn(`[EFC] scanDir: max depth (${maxDepth}) reached at ${dir}, skipping subtree`);
    return [];
  }

  const entries: RouteEntry[] = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...scanDir(fullPath, base, maxDepth, _depth + 1));
    } else if (ROUTE_FILE_RE.test(item.name)) {
      const relative = '/' + path.relative(base, fullPath).replace(/\\/g, '/');
      const segs = segmentsOf(relative);
      const pattern = buildPattern(segs);
      entries.push({
        urlPath: filePathToUrlPath(relative),
        filePath: fullPath,
        params: extractParams(relative),
        ...(pattern !== undefined && { pattern }),
      });
    }
  }

  // Most specific first (segment-by-segment rank), ties broken alphabetically.
  const rel = (e: RouteEntry) => '/' + path.relative(base, e.filePath).replace(/\\/g, '/');
  return entries.sort((a, b) => {
    const diff = compareSpecificity(segmentsOf(rel(a)), segmentsOf(rel(b)));
    return diff !== 0 ? diff : a.urlPath.localeCompare(b.urlPath);
  });
}

export { filePathToUrlPath };
