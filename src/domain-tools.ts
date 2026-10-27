import * as z from 'zod/v4';
import { DOMAINS } from './domains.generated.js';
import { OPERATIONS, type OperationSpec, type ParameterSpec } from './operations.generated.js';
import { metaSchema } from './schemas.js';
import type { Query } from './routes.js';

// Schemas stay light because every tool repeats them in the tool list; the HTTP client enforces the strict bounds again.
const NUMERIC_ID = /^\d{1,19}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

// The client only reads JSON; these routes answer with files and are not exposed yet.
const UNSUPPORTED = new Set(['/employees/{id}/statements/{year}-{month}.pdf']);

const specByPath = new Map(OPERATIONS.map((operation) => [operation.path, operation]));

// Lean on purpose: every tool repeats this schema in the tool list, so only the fields a client needs to branch on are declared.
export const domainOutputSchema = z.object({
  operation: z.string(),
  data: z.unknown(),
  meta: z.object({ complete: z.boolean() }).loose(),
  warnings: z.array(z.string()),
});

export type DomainOutput = z.infer<typeof domainOutputSchema> & { meta: z.infer<typeof metaSchema> };

export function operationName(path: string): string {
  return path.replace(/\{(\w+)\}/g, 'by_$1').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function domainToolNames(): string[] {
  return Object.entries(DOMAINS).filter(([, domain]) => !domain.phaseOne).map(([name]) => name);
}

export function isUnsupported(path: string): boolean {
  return UNSUPPORTED.has(path);
}

/** Public argument name: the Swagger key without the `[]` suffix. */
export function publicName(parameter: ParameterSpec): string {
  return parameter.name.replace(/\[\]$/, '');
}

/** Array parameters that publish neither a collection format nor item type have an unknown wire encoding. */
function encodable(parameter: ParameterSpec): boolean {
  return parameter.type !== 'array' || (parameter.collectionFormat === 'multi' && parameter.itemType === 'integer');
}

const GENERIC = new Set(['page', 'page_size']);
const MAX_DESCRIPTION = 90;

function describe<T extends z.ZodType>(schema: T, parameter: ParameterSpec): T {
  if (GENERIC.has(parameter.name)) return schema;
  const base = (parameter.description ?? '').replace(/\(OPCIONAL\)\s*/i, '');
  const text = [base.length > MAX_DESCRIPTION ? `${base.slice(0, MAX_DESCRIPTION - 1)}…` : base, parameter.enum && !schema.description ? `Valores: ${parameter.enum.join(', ')}.` : ''].filter(Boolean).join(' ').trim();
  return (text ? schema.describe(text) : schema) as T;
}

function parameterSchema(parameter: ParameterSpec): z.ZodType {
  if (parameter.in === 'path') {
    return describe(parameter.type === 'integer' ? z.string().regex(NUMERIC_ID) : z.string().regex(SAFE_SEGMENT), parameter);
  }
  let schema: z.ZodType;
  if (parameter.type === 'array') schema = z.array(z.number().int().min(0)).min(1).max(100);
  else if (parameter.type === 'boolean') schema = z.boolean();
  else if (parameter.type === 'integer') {
    schema = parameter.enum ? z.union(parameter.enum.map((value) => z.literal(value))) : parameter.name === 'page' ? z.number().int().min(1).max(500) : parameter.name === 'page_size' ? z.number().int().min(1).max(100) : z.number().min(0);
  } else if (parameter.enum) {
    schema = parameter.enum.every((value) => typeof value === 'string') ? z.enum(parameter.enum as [string, ...string[]]) : z.union(parameter.enum.map((value) => z.literal(value)));
  } else schema = parameter.format === 'date' ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/) : z.string();
  return describe(parameter.required ? schema : schema.optional(), parameter);
}

function variantShape(operation: OperationSpec): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  const summary = `${operation.deprecated ? '[OBSOLETO] ' : ''}${operation.summary}`.trim();
  shape.operation = summary ? z.literal(operationName(operation.path)).describe(summary) : z.literal(operationName(operation.path));
  for (const parameter of operation.parameters) {
    if (!encodable(parameter)) continue;
    const key = publicName(parameter);
    if (Object.hasOwn(shape, key)) throw new Error(`Parameter name collision in ${operation.path}: ${key}`);
    shape[key] = parameterSchema(parameter);
  }
  if (operation.paginated) shape.all_pages = z.boolean().optional().describe('true: todas las páginas');
  return shape;
}

const schemaCache = new Map<string, z.ZodObject>();

export function domainOperations(tool: string): OperationSpec[] {
  const domain = DOMAINS[tool];
  if (!domain || domain.phaseOne) return [];
  return domain.operations.filter((path) => !isUnsupported(path)).map((path) => {
    const operation = specByPath.get(path);
    if (!operation) throw new Error(`Registry is missing ${path}`);
    return operation;
  });
}

export function buildDomainInputSchema(tool: string): z.ZodObject {
  const cached = schemaCache.get(tool);
  if (cached) return cached;
  const variants = domainOperations(tool).map((operation) => z.object(variantShape(operation)).strict());
  if (variants.length === 0) throw new Error(`Unknown domain tool ${tool}`);
  const request = variants.length === 1 ? variants[0]! : z.discriminatedUnion('operation', variants as [typeof variants[0], typeof variants[0], ...typeof variants]);
  const schema = z.object({ request }).strict();
  schemaCache.set(tool, schema);
  return schema;
}

export interface ResolvedRequest {
  operation: OperationSpec;
  name: string;
  path: string;
  query: Query;
  allPages: boolean;
}

export function resolveRequest(tool: string, request: Record<string, unknown>): ResolvedRequest {
  const operation = domainOperations(tool).find((candidate) => operationName(candidate.path) === request.operation);
  if (!operation) throw new Error('Unknown operation');
  let path = operation.path;
  const query: Query = {};
  for (const parameter of operation.parameters) {
    const value = request[publicName(parameter)];
    if (value === undefined) continue;
    if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, String(value));
    else query[parameter.name] = value as Query[string];
  }
  return { operation, name: operationName(operation.path), path, query, allPages: request.all_pages === true };
}
