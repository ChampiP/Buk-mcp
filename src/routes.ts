import { BukServiceError } from './errors.js';
import { OPERATIONS, type OperationSpec, type ParameterSpec } from './operations.generated.js';

export type QueryValue = string | number | boolean;
export type Query = Record<string, QueryValue | readonly number[]>;

export interface Route {
  operation: OperationSpec;
  pathParameters: Record<string, string>;
}

const MAX_STRING = 256;
const MAX_ARRAY = 100;
const CANONICAL_INTEGER = '(?:0|[1-9]\\d{0,18})';
const SAFE_SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.\\-]{0,127}';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const continuationKeys = new Set(['page', 'page_size']);

// Phase-one tools were stricter than the Swagger; keep exactly that behavior.
const PHASE_ONE: Record<string, { integerPath?: boolean; required?: string[]; enums?: Record<string, (string | number | boolean)[]> }> = {
  '/employees/active': { required: ['date', 'exclude_pending'] },
  '/employees': { enums: { sort: ['id'], status: ['activo', 'inactivo', 'pendiente'] } },
  '/employees/{id}': { integerPath: true },
  '/employees/{id}/jobs': { integerPath: true },
};

function deny(message: string, code: string): never {
  throw new BukServiceError(message, code);
}

const compiled = OPERATIONS.map((operation) => {
  const override = PHASE_ONE[operation.path];
  const params = new Map(operation.parameters.filter((p) => p.in === 'path').map((p) => [p.name, p]));
  const names: string[] = [];
  const source = operation.path.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(name);
    const integer = override?.integerPath === true || params.get(name)?.type === 'integer';
    return `(${integer ? CANONICAL_INTEGER : SAFE_SEGMENT})`;
  }).join('');
  return { operation, names, pattern: new RegExp(`^${source}$`) };
}).sort((a, b) => a.names.length - b.names.length);

export function matchRoute(path: string): Route {
  if (/%(?:2f|5c|2e)/i.test(path) || path.includes('\\') || path.includes('?') || path.includes('#')) deny('BUK route is not allowed', 'BUK_ROUTE_DENIED');
  for (const { operation, names, pattern } of compiled) {
    const match = pattern.exec(path);
    if (match) return { operation, pathParameters: Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? ''])) };
  }
  return deny('BUK route is not allowed', 'BUK_ROUTE_DENIED');
}

function isMultiInteger(spec: ParameterSpec): boolean {
  return spec.type === 'array' && spec.collectionFormat === 'multi' && spec.itemType === 'integer';
}

function valueAllowed(spec: ParameterSpec, key: string, value: unknown, enums: (string | number | boolean)[] | undefined): boolean {
  if (spec.type === 'array') {
    return isMultiInteger(spec) && Array.isArray(value) && value.length >= 1 && value.length <= MAX_ARRAY
      && value.every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0);
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return false;
  if (key === 'page' || key === 'page_size') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= (key === 'page' ? 500 : 100);
  }
  const allowed = enums ?? spec.enum;
  if (allowed && !allowed.map(String).includes(String(value))) return false;
  switch (spec.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    default:
      if (typeof value !== 'string' || value.length > MAX_STRING) return false;
      return spec.format !== 'date' || DATE.test(value);
  }
}

export function validateQuery(route: Route, query: Query, continuation = false): void {
  const override = PHASE_ONE[route.operation.path];
  const specs = new Map(route.operation.parameters.filter((p) => p.in === 'query').map((p) => [p.name, p]));
  for (const [key, value] of Object.entries(query)) {
    const spec = specs.get(key) ?? (continuation && continuationKeys.has(key) ? { name: key, in: 'query' as const, required: false, type: 'integer' as const } : undefined);
    if (!spec || !valueAllowed(spec, key, value, override?.enums?.[key])) deny('BUK query is not allowed', 'BUK_QUERY_DENIED');
  }
  const required = new Set([...(override?.required ?? []), ...[...specs.values()].filter((p) => p.required).map((p) => p.name)]);
  for (const key of required) if (query[key] === undefined) deny('BUK request is missing a required query parameter', 'BUK_QUERY_DENIED');
}

export function appendQuery(url: URL, query: Query): void {
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
}

export function parseQuery(route: Route, url: URL): Query {
  const specs = new Map(route.operation.parameters.filter((p) => p.in === 'query').map((p) => [p.name, p]));
  const result: Record<string, QueryValue | number[]> = {};
  for (const [key, raw] of url.searchParams) {
    const spec = specs.get(key);
    if (spec && isMultiInteger(spec)) {
      if (!/^\d+$/.test(raw)) deny('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
      const list = (result[key] ??= []) as number[];
      list.push(Number(raw));
      continue;
    }
    if (Object.hasOwn(result, key)) deny('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
    if (spec?.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') deny('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
      result[key] = raw === 'true';
    } else if (key === 'page' || key === 'page_size' || spec?.type === 'integer') {
      if (!/^\d+$/.test(raw)) deny('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
      result[key] = Number(raw);
    } else {
      result[key] = raw;
    }
  }
  return result;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { continuationKeys };
