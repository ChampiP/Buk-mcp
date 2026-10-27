import { BukHttpClient, type Query } from './client.js';
import { buildDomainInputSchema, domainToolNames, resolveRequest, type DomainOutput } from './domain-tools.js';
import { BukServiceError } from './errors.js';
import { ensureSmall, isRecord, newMeta, parsePagination, ToolBudget, type Pagination } from './runtime.js';

export interface DomainServiceOptions {
  client: BukHttpClient;
  maxCalls?: number;
  maxRecords?: number;
  toolTimeoutMs?: number;
  maxToolOutputBytes?: number;
  now?: () => Date;
}

export interface DomainCallOptions {
  signal?: AbortSignal;
}

interface Body {
  rows: unknown[] | null;
  single: unknown;
  pagination: Pagination | null;
  /** True when a single object carries a paginated sub-list that this call does not traverse. */
  subListPaginated: boolean;
}

const COUNT_SEMANTICS_PROVIDER = 'pagination.count del proveedor; puede ser local a la página';
const COUNT_SEMANTICS_TRAVERSED = 'registros devueltos tras recorrer todas las páginas';

// BUK answers lists as `{ data: [...] }`, as a bare array, or as `{ pagination, <collection>: [...] }`.
function parseBody(raw: unknown): Body {
  if (Array.isArray(raw)) return { rows: raw, single: undefined, pagination: null, subListPaginated: false };
  if (isRecord(raw) && 'data' in raw) {
    const pagination = parsePagination(raw.pagination);
    if (Array.isArray(raw.data)) return { rows: raw.data, single: undefined, pagination, subListPaginated: false };
    return { rows: null, single: raw.data, pagination, subListPaginated: false };
  }
  if (isRecord(raw) && isRecord(raw.pagination)) {
    const pagination = parsePagination(raw.pagination);
    const collections = Object.entries(raw).filter(([key, value]) => key !== 'pagination' && Array.isArray(value));
    const scalars = Object.keys(raw).filter((key) => key !== 'pagination' && !Array.isArray(raw[key]));
    if (collections.length === 1 && scalars.length === 0) return { rows: collections[0]![1] as unknown[], single: undefined, pagination, subListPaginated: false };
    return { rows: null, single: raw, pagination: null, subListPaginated: pagination?.next != null };
  }
  return { rows: null, single: raw, pagination: null, subListPaginated: false };
}

export function createDomainService(options: DomainServiceOptions) {
  const maxCalls = options.maxCalls ?? 50;
  const maxRecords = options.maxRecords ?? 5000;
  const toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 100_000;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 60_000 || !Number.isInteger(maxToolOutputBytes) || maxToolOutputBytes < 1 || maxToolOutputBytes > 100_000) {
    throw new BukServiceError('BUK tool limits are outside the supported range', 'BUK_CONFIG_INVALID');
  }
  const knownTools = new Set(domainToolNames());

  async function query(tool: string, input: unknown, callOptions: DomainCallOptions = {}): Promise<DomainOutput> {
    if (!knownTools.has(tool)) throw new BukServiceError('Unknown BUK tool', 'BUK_INVALID_ARGUMENT');
    const parsed = buildDomainInputSchema(tool).safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BukServiceError(`Invalid arguments${issue ? `: ${issue.path.join('.') || 'request'} ${issue.message}` : ''}`, 'BUK_INVALID_ARGUMENT');
    }
    const request = resolveRequest(tool, (parsed.data as { request: Record<string, unknown> }).request);
    const budget = new ToolBudget(maxCalls, toolTimeoutMs, callOptions.signal);
    const warnings: string[] = [];
    if (request.operation.deprecated) warnings.push('Operación obsoleta en BUK; puede dejar de responder.');
    if (!request.operation.hasResponseSchema) warnings.push('BUK no publica esquema de respuesta para esta operación; la forma de los datos no está garantizada.');

    const first = parseBody(await options.client.get(request.path, request.query as Query, budget.requestOptions()));
    const rows: unknown[] = first.rows ? [...first.rows] : [];
    let pagination = first.pagination;
    let calls = budget.calls;
    let next = pagination?.next ?? null;
    let complete = true;

    if (first.rows && next) {
      if (!request.allPages) {
        complete = false;
        warnings.push(request.operation.paginated
          ? 'BUK indica más páginas. Repite con all_pages: true para recorrerlas dentro del presupuesto.'
          : 'BUK indica más páginas, pero esta operación no admite recorrerlas.');
      } else {
        const links = new Set<string>();
        while (next) {
          if (links.has(next)) { complete = false; warnings.push('BUK repitió un enlace de paginación; se detuvo el recorrido.'); break; }
          links.add(next);
          if (!budget.canContinue() || rows.length >= maxRecords) { complete = false; warnings.push('Se alcanzó el presupuesto de llamadas, tiempo o registros antes de terminar; el resultado es parcial.'); break; }
          const page = parseBody(await options.client.getNextPage(next, request.path, request.query as Query, budget.requestOptions()));
          if (!page.rows) throw new BukServiceError('BUK response has an unsupported or malformed envelope', 'BUK_RESPONSE_ENVELOPE');
          rows.push(...page.rows);
          pagination = page.pagination;
          next = page.pagination?.next ?? null;
        }
        calls = budget.calls;
      }
    }

    if (first.subListPaginated) {
      complete = false;
      warnings.push('El objeto incluye una sublista con más páginas que esta operación no recorre; el resultado es parcial.');
    }
    const isList = first.rows !== null;
    const totalCount = complete && isList && request.allPages ? rows.length : pagination?.count ?? null;
    const semantics = complete && isList && request.allPages ? COUNT_SEMANTICS_TRAVERSED : COUNT_SEMANTICS_PROVIDER;
    const build = (): DomainOutput => ({
      operation: request.name,
      data: isList ? rows : first.single,
      meta: newMeta(now, complete, isList ? rows.length : 1, totalCount, calls, semantics),
      warnings,
    });
    if (!isList) {
      const output = build();
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > maxToolOutputBytes) throw new BukServiceError('BUK output exceeded the size limit; use narrower filters', 'BUK_OUTPUT_TOO_LARGE');
      return output;
    }
    return ensureSmall(rows, build, maxToolOutputBytes, () => {
      complete = false;
      warnings.push('Salida recortada por tamaño: se devolvieron menos registros de los obtenidos; usa filtros más estrechos.');
    });
  }

  return { query };
}

export type DomainService = ReturnType<typeof createDomainService>;
