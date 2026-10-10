import type { Request, RequestHandler } from 'express';
import type { RequestSchema, RouteSchema, ValidationIssue, Validator } from '../types.js';

const LOCATIONS = ['params', 'query', 'body'] as const;
type Location = (typeof LOCATIONS)[number];

interface StandardResult {
  value?: unknown;
  issues?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  }>;
}

function isRequestSchema(value: unknown): value is RequestSchema {
  return (
    value != null &&
    typeof value === 'object' &&
    LOCATIONS.some((loc) => loc in (value as Record<string, unknown>))
  );
}

/** Picks the schema for `method`: a method-keyed entry wins over a file-wide one. */
export function schemaFor(
  schema: RouteSchema | undefined,
  method: string,
): RequestSchema | undefined {
  if (!schema) return undefined;
  const byMethod = (schema as Record<string, unknown>)[method];
  if (isRequestSchema(byMethod)) return byMethod;
  return isRequestSchema(schema) ? schema : undefined;
}

type IssuePath = ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined;

function pathToString(path: IssuePath): string {
  if (!path) return '';
  return path
    .map((p) => (typeof p === 'object' && p !== null && 'key' in p ? p.key : p))
    .map(String)
    .join('.');
}

// Standard Schema (zod >=3.24, valibot, arktype, ...) first; plain zod-style
// safeParse as a fallback so older zod 3 releases work too.
async function run(validator: Validator, input: unknown): Promise<StandardResult> {
  const std = (validator as { '~standard'?: { validate: (v: unknown) => unknown } })['~standard'];
  if (std && typeof std.validate === 'function') {
    return (await std.validate(input)) as StandardResult;
  }
  const v = validator as {
    safeParseAsync?: (x: unknown) => Promise<unknown>;
    safeParse?: (x: unknown) => unknown;
  };
  const parse = v.safeParseAsync ?? v.safeParse;
  if (typeof parse !== 'function') {
    throw new Error('[EFC] Route schema entries must be Standard Schema validators (e.g. zod)');
  }
  const r = (await parse.call(validator, input)) as {
    success: boolean;
    data?: unknown;
    error?: { issues: Array<{ message: string; path: PropertyKey[] }> };
  };
  return r.success ? { value: r.data } : { issues: r.error?.issues ?? [{ message: 'Invalid' }] };
}

/**
 * Validates params/query/body against the route's schema. On success the parsed
 * output replaces the raw input (so coercions and defaults apply); on failure
 * responds 400 with every issue across all locations.
 */
export function validateRequest(schema: RequestSchema): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const issues: ValidationIssue[] = [];
      const parsed: Partial<Record<Location, unknown>> = {};

      for (const location of LOCATIONS) {
        const validator = schema[location];
        if (!validator) continue;
        const result = await run(validator, req[location]);
        if (result.issues) {
          for (const issue of result.issues) {
            issues.push({ location, path: pathToString(issue.path), message: issue.message });
          }
        } else {
          parsed[location] = result.value;
        }
      }

      if (issues.length > 0) {
        res.status(400).json({ error: 'Validation failed', statusCode: 400, issues });
        return;
      }

      for (const location of LOCATIONS) {
        if (location in parsed) {
          // req.query is a getter in some Express setups — define rather than assign.
          Object.defineProperty(req as Request, location, {
            value: parsed[location],
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
      }
      next();
    })().catch(next);
  };
}
