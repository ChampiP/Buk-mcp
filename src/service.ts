import { BukHttpClient, type Query } from './client.js';
import { BukServiceError } from './errors.js';
import { ensureSmall, invalidEnvelope, isRecord, newMeta, parsePagination, ToolBudget, type CollectionResult, type Page, type Pagination } from './runtime.js';
import {
  employeeContextInputSchema,
  employeesSearchInputSchema,
  workforceInputSchema,
  type EmployeeContextInput,
  type EmployeeContextOutput,
  type EmployeesSearchInput,
  type EmployeesSearchOutput,
  type WorkforceInput,
  type WorkforceOutput,
} from './schemas.js';

export interface BukServiceOptions {
  client: BukHttpClient;
  maxCalls?: number;
  maxRecords?: number;
  toolTimeoutMs?: number;
  maxToolOutputBytes?: number;
  now?: () => Date;
}

export interface ServiceCallOptions {
  signal?: AbortSignal;
}

const DAILY_TIME_WARNING = 'La API documentada de BUK no expone horarios diarios ni hora de entrada/salida.';
const PAGINATION_WARNING = 'BUK pagination.count informa registros del proveedor; no demuestra personas únicas.';

function parsePage(value: unknown, allowArray = true): Page {
  if (Array.isArray(value)) {
    if (!allowArray) return invalidEnvelope();
    if (!value.every(isRecord)) return invalidEnvelope();
    return { items: value, pagination: null };
  }
  if (!isRecord(value) || !Array.isArray(value.data) || Object.keys(value).some((key) => key !== 'data' && key !== 'pagination')) return invalidEnvelope();
  if (!value.data.every(isRecord)) return invalidEnvelope();
  return { items: value.data, pagination: parsePagination(value.pagination) };
}

function parseEmployee(value: unknown, expectedId: string): Record<string, unknown> {
  if (!isRecord(value)) return invalidEnvelope();
  let record = value;
  if (Object.hasOwn(value, 'data')) {
    if (Object.keys(value).some((key) => key !== 'data') || !isRecord(value.data)) return invalidEnvelope();
    record = value.data;
  }
  if (Object.hasOwn(record, 'data') || identifier(record.id) !== expectedId) return invalidEnvelope();
  return record;
}

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function sourceDate(record: Record<string, unknown>, key: string, sourceField: string) {
  return { value: typeof record[key] === 'string' ? record[key] as string : null, source_field: sourceField };
}

function sourceValue(value: unknown, sourceField: string): { value: string | number | boolean | string[] | null; source_field: string } {
  if (typeof value === 'string' || typeof value === 'boolean') return { value, source_field: sourceField };
  if (typeof value === 'number' && Number.isFinite(value)) return { value, source_field: sourceField };
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return { value: value as string[], source_field: sourceField };
  return { value: null, source_field: sourceField };
}

function roleProjection(value: unknown): { id: string | null; code: string | null; name: string | null } {
  if (!isRecord(value)) return { id: null, code: null, name: null };
  return {
    id: identifier(value.id),
    code: typeof value.code === 'string' ? value.code : null,
    name: typeof value.name === 'string' ? value.name : null,
  };
}

function projectCandidate(record: Record<string, unknown>) {
  const job = isRecord(record.current_job) ? record.current_job : {};
  return {
    id: identifier(record.id),
    full_name: typeof record.full_name === 'string' ? record.full_name : null,
    status: typeof record.status === 'string' ? record.status : null,
    active_since: sourceDate(record, 'active_since', 'active_since'),
    position: roleProjection(job.role),
  };
}

function projectEmployee(record: Record<string, unknown>, includeSalary: boolean) {
  const job = isRecord(record.current_job) ? record.current_job : {};
  const baseWage = job.base_wage;
  const salary = includeSalary
    ? {
        amount: typeof baseWage === 'number' && Number.isFinite(baseWage) && baseWage >= 0 ? baseWage : null,
        currency: null,
        source_field: 'current_job.base_wage' as const,
        currency_source_field: null,
      }
    : null;
  return {
    id: identifier(record.id),
    full_name: typeof record.full_name === 'string' ? record.full_name : null,
    status: typeof record.status === 'string' ? record.status : null,
    dates: {
      active_since: sourceDate(record, 'active_since', 'active_since'),
      employee_active_until: sourceDate(record, 'active_until', 'active_until'),
      start_date: sourceDate(job, 'start_date', 'current_job.start_date'),
      end_date: sourceDate(job, 'end_date', 'current_job.end_date'),
      contract_term: sourceDate(job, 'contract_term', 'current_job.contract_term'),
      current_job_active_until: sourceDate(job, 'active_until', 'current_job.active_until'),
      contract_finishing_date_1: sourceDate(job, 'contract_finishing_date_1', 'current_job.contract_finishing_date_1'),
      contract_finishing_date_2: sourceDate(job, 'contract_finishing_date_2', 'current_job.contract_finishing_date_2'),
    },
    position: roleProjection(job.role),
    schedule: {
      weekly_hours: sourceValue(job.weekly_hours, 'current_job.weekly_hours'),
      days: sourceValue(job.days, 'current_job.days'),
      working_schedule_type: sourceValue(job.working_schedule_type, 'current_job.working_schedule_type'),
      periodicity: sourceValue(job.periodicity, 'current_job.periodicity'),
      frequency: sourceValue(job.frequency, 'current_job.frequency'),
      daily_start_time: null,
      daily_end_time: null,
      daily_times_available: false as const,
    },
    salary,
  };
}

function projectJob(record: Record<string, unknown>) {
  return {
    dates: {
      start_date: sourceDate(record, 'start_date', 'jobs[].start_date'),
      end_date: sourceDate(record, 'end_date', 'jobs[].end_date'),
      end_of_contract: sourceDate(record, 'end_of_contract', 'jobs[].end_of_contract'),
    },
    role: roleProjection(record.role),
    regular_hours: sourceValue(record.regular_hours, 'jobs[].regular_hours'),
  };
}

function recordSignature(records: unknown[]): string {
  return JSON.stringify(records);
}

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function ensureValidDate(value: string, field: string): void {
  if (!validCalendarDate(value)) throw new BukServiceError(`${field} must be a real YYYY-MM-DD date`, 'BUK_INVALID_ARGUMENT');
}

function countFrom(pagination: Pagination | null): number | null {
  return pagination?.count ?? null;
}

function addCountWarning(warnings: string[], totalCount: number | null, returnedCount: number, comparison = 'IDs únicos devueltos'): void {
  if (totalCount === null) warnings.push('BUK no entregó pagination.count; el total no está confirmado.');
  else if (totalCount !== returnedCount) warnings.push(`BUK pagination.count informa registros del proveedor; el total no coincide con ${comparison}.`);
}

export function createBukService(options: BukServiceOptions) {
  const maxCalls = options.maxCalls ?? 50;
  const maxRecords = options.maxRecords ?? 5000;
  const toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 100_000;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 60_000 || !Number.isInteger(maxToolOutputBytes) || maxToolOutputBytes < 1 || maxToolOutputBytes > 100_000) {
    throw new BukServiceError('BUK tool limits are outside the supported range', 'BUK_CONFIG_INVALID');
  }

  function budgetFor(signal?: AbortSignal): ToolBudget {
    return new ToolBudget(maxCalls, toolTimeoutMs, signal);
  }

  function validListNext(next: string | null | undefined, path: string, query: Query): void {
    if (next !== undefined && next !== null) options.client.validateNextPage(next, path, query);
  }

  async function workforceSummary(input: unknown, callOptions: ServiceCallOptions = {}): Promise<WorkforceOutput> {
    const parsed = workforceInputSchema.safeParse(input);
    if (!parsed.success) throw new BukServiceError('Invalid workforce summary arguments', 'BUK_INVALID_ARGUMENT');
    const args: WorkforceInput = parsed.data;
    ensureValidDate(args.as_of, 'as_of');
    const query: Query = { date: args.as_of, exclude_pending: args.exclude_pending, page_size: 100 };
    const budget = budgetFor(callOptions.signal);
    const warnings: string[] = [];
    const ids = new Set<string>();
    const pageSignatures = new Set<string>();
    const nextLinks = new Set<string>();
    let pageCountsMissing = false;
    let pageCountsMismatch = false;
    let totalPagesConsistent = true;
    let complete = true;
    let endedWithExplicitNull = false;
    let truncated = false;
    let missingId = false;
    let pagesRead = 0;
    let declaredPages: number | null = null;
    let next: string | null | undefined;
    let first = true;

    while (first || next !== null) {
      first = false;
      let raw: unknown;
      try {
        raw = typeof next === 'string'
          ? await options.client.getNextPage(next, '/employees/active', query, budget.requestOptions())
          : await options.client.get('/employees/active', query, budget.requestOptions());
      } catch (error) {
        if (pagesRead > 0 && error instanceof BukServiceError && error.code === 'BUK_BUDGET_EXCEEDED') {
          complete = false;
          warnings.push('Se alcanzó el presupuesto de llamadas o tiempo; el conteo es parcial e incompleto.');
          break;
        }
        throw error;
      }
      const page = parsePage(raw, false);
      pagesRead += 1;
      if (page.pagination?.total_pages !== undefined) {
        if (declaredPages !== null && declaredPages !== page.pagination.total_pages) totalPagesConsistent = false;
        declaredPages = page.pagination.total_pages;
      }
      const idsOnPage = page.items.map((record) => identifier(record.id));
      const uniquePageCount = new Set(idsOnPage.filter((id): id is string => id !== null)).size;
      if (page.pagination?.count === undefined) pageCountsMissing = true;
      else if (page.pagination.count !== uniquePageCount) pageCountsMismatch = true;
      const signature = recordSignature(idsOnPage);
      if (pageSignatures.has(signature)) {
        complete = false;
        warnings.push('Se detectó una página repetida; el conteo no se considera final.');
        break;
      }
      pageSignatures.add(signature);
      for (const id of idsOnPage) {
        if (id === null) {
          missingId = true;
          continue;
        }
        if (!ids.has(id) && ids.size >= maxRecords) {
          truncated = true;
          break;
        }
        ids.add(id);
      }
      if (truncated || missingId) {
        if (truncated) warnings.push('Se alcanzó el límite de registros; el conteo es parcial e incompleto.');
        if (missingId) warnings.push('Algunos registros no incluyeron id; no se pueden contar como empleados únicos.');
        complete = false;
        break;
      }
      next = page.pagination?.next;
      if (typeof next === 'string') {
        validListNext(next, '/employees/active', query);
        if (nextLinks.has(next) || !budget.canContinue()) {
          complete = false;
          warnings.push(nextLinks.has(next) ? 'Se detectó un ciclo de paginación.' : 'Se alcanzó el presupuesto de llamadas o tiempo; el conteo es parcial e incompleto.');
          break;
        }
        nextLinks.add(next);
      } else if (next === null) {
        endedWithExplicitNull = true;
        break;
      } else {
        complete = false;
        break;
      }
    }
    if (!totalPagesConsistent) {
      complete = false;
      warnings.push('BUK informó distintos total_pages durante el recorrido; la cobertura no se considera completa.');
    }
    if (declaredPages !== null && pagesRead !== declaredPages) {
      complete = false;
      warnings.push('El total de páginas informado por BUK no coincide con las páginas recorridas.');
    }
    if (pageCountsMissing) {
      complete = false;
      warnings.push('Falta pagination.count en al menos una página; el conteo global no está confirmado.');
    }
    if (pageCountsMismatch) {
      complete = false;
      warnings.push('Al menos una pagination.count no coincide con los IDs únicos devueltos en esa página.');
    }
    if (!endedWithExplicitNull) {
      complete = false;
      if (!warnings.some((warning) => warning.includes('presupuesto') || warning.includes('página repetida') || warning.includes('ciclo'))) {
        warnings.push('BUK no confirmó el fin de la paginación; el conteo es parcial e incompleto.');
      }
    }
    const totalCount = complete ? ids.size : null;
    const result: WorkforceOutput = {
      data: { as_of: args.as_of, exclude_pending: args.exclude_pending, unit: 'employee_records', count: totalCount },
      meta: newMeta(now, complete, ids.size, totalCount, budget.calls, 'Computed final unique employee ID total after a complete validated traversal; BUK pagination.count is page-local and checked against unique IDs per page.'),
      warnings,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxToolOutputBytes) {
      throw new BukServiceError('BUK output exceeded the size limit', 'BUK_OUTPUT_TOO_LARGE');
    }
    return result;
  }

  async function employeesSearch(input: unknown, callOptions: ServiceCallOptions = {}): Promise<EmployeesSearchOutput> {
    const parsed = employeesSearchInputSchema.safeParse(input);
    if (!parsed.success) throw new BukServiceError('Invalid employee search arguments', 'BUK_INVALID_ARGUMENT');
    const args: EmployeesSearchInput = parsed.data;
    if (![
      args.status, args.document_number, args.code_sheet, args.company_id, args.update_start_date,
      args.custom_attr_job_name, args.custom_attr_job_value, args.email, args.code_recinto,
    ].some((value) => value !== undefined)) throw new BukServiceError('At least one documented employee filter is required', 'BUK_INVALID_ARGUMENT');
    if (args.update_start_date) ensureValidDate(args.update_start_date, 'update_start_date');
    const query: Query = { page: args.page, page_size: args.page_size };
    for (const key of ['status', 'document_number', 'code_sheet', 'company_id', 'update_start_date', 'custom_attr_job_name', 'custom_attr_job_value', 'email', 'code_recinto', 'sort'] as const) {
      const value = args[key];
      if (value !== undefined) query[key] = value;
    }
    const budget = budgetFor(callOptions.signal);
    const page = parsePage(await options.client.get('/employees', query, budget.requestOptions()));
    validListNext(page.pagination?.next, '/employees', query);
    const warnings: string[] = [];
    const seenIds = new Set<string>();
    const candidates = [] as ReturnType<typeof projectCandidate>[];
    let incompleteId = false;
    const signatures = new Set<string>();
    for (const record of page.items) {
      const candidate = projectCandidate(record);
      const signature = JSON.stringify(candidate);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      if (candidate.id === null) incompleteId = true;
      else if (seenIds.has(candidate.id)) continue;
      else seenIds.add(candidate.id);
      if (candidates.length >= maxRecords) break;
      candidates.push(candidate);
    }
    const totalCount = countFrom(page.pagination);
    const hasNext = typeof page.pagination?.next === 'string';
    const hasPaginationEnd = page.pagination?.next === null;
    let complete = hasPaginationEnd && totalCount !== null && totalCount === seenIds.size && !incompleteId && candidates.length === page.items.length && (page.pagination?.total_pages === undefined || page.pagination.total_pages === 1);
    if (hasNext) warnings.push('Hay más candidatos: la búsqueda devuelve una página por llamada; indica page para continuar.');
    else if (!hasPaginationEnd) warnings.push('BUK no confirmó el fin de la paginación; el total es parcial.');
    if (page.pagination?.total_pages !== undefined && page.pagination.total_pages > 1) warnings.push('BUK indicó páginas adicionales; la búsqueda devuelve una página por llamada.');
    if (totalCount === null) warnings.push('BUK no entregó pagination.count; el total no está confirmado.');
    if (incompleteId) warnings.push('Algunos candidatos no incluyeron id y no se pudo deduplicar el resultado.');
    if (totalCount !== null && totalCount !== seenIds.size) warnings.push(PAGINATION_WARNING);
    if (candidates.length < page.items.length) {
      complete = false;
      warnings.push('Se alcanzó el límite de registros o se deduplicaron filas; revisa la cobertura de la página.');
    }
    const result = (): EmployeesSearchOutput => ({
      data: { candidates },
      meta: { ...newMeta(now, complete, candidates.length, totalCount, budget.calls, 'BUK pagination.count reports source records; candidates are deduplicated by employee ID.'), page: args.page, page_size: args.page_size },
      warnings,
    });
    return ensureSmall(candidates, result, maxToolOutputBytes, () => {
      complete = false;
      warnings.push('La salida alcanzó el límite de tamaño; faltan candidatos de esta página.');
    });
  }

  async function employeeContext(input: unknown, callOptions: ServiceCallOptions = {}): Promise<EmployeeContextOutput> {
    const parsed = employeeContextInputSchema.safeParse(input);
    if (!parsed.success) throw new BukServiceError('Invalid employee context arguments', 'BUK_INVALID_ARGUMENT');
    const args: EmployeeContextInput = parsed.data;
    const budget = budgetFor(callOptions.signal);
    const employeeRecord = parseEmployee(await options.client.get(`/employees/${args.employee_id}`, {}, budget.requestOptions()), args.employee_id);
    const warnings = [DAILY_TIME_WARNING];
    const employee = projectEmployee(employeeRecord, args.include_salary);
    let jobs: ReturnType<typeof projectJob>[] = [];
    let jobsComplete = true;
    let jobsTotalCount: number | null = 0;
    let jobsCalls = 0;
    if (args.include_jobs) {
      const beforeCalls = budget.calls;
      if (callOptions.signal?.aborted) throw new BukServiceError('BUK request cancelled', 'BUK_CANCELLED');
      if (!budget.canContinue()) {
        jobsComplete = false;
        jobsTotalCount = null;
        warnings.push('Se alcanzó el presupuesto de llamadas o tiempo; el historial es parcial e incompleto.');
      } else {
        const jobResult = await collectJobs(options.client, args.employee_id, budget, maxRecords);
        jobs = jobResult.records;
        jobsComplete = jobResult.complete;
        jobsTotalCount = jobResult.totalCount;
        warnings.push(...jobResult.warnings);
      }
      jobsCalls = budget.calls - beforeCalls;
    }
    if (args.include_salary) warnings.push('BUK no publica una moneda explícita para current_job.base_wage; payment_currency no se usa como moneda del sueldo.');
    const output = (): EmployeeContextOutput => ({
      data: { employee, jobs, salary_included: args.include_salary },
      meta: newMeta(now, jobsComplete, 1, 1, budget.calls, 'One employee detail record; jobs history has separate pagination metadata.'),
      jobs_meta: {
        complete: jobsComplete,
        returned_count: jobs.length,
        total_count: jobsTotalCount,
        total_count_semantics: 'BUK pagination.count reports job records; the schema publishes no job ID for deduplication.',
        upstream_calls: jobsCalls,
      },
      warnings,
    });
    return ensureSmall(jobs, output, maxToolOutputBytes, () => {
      jobsComplete = false;
      warnings.push('La salida alcanzó el límite de tamaño; el historial de puestos está incompleto.');
    });
  }

  return { workforceSummary, employeesSearch, employeeContext };
}

export type BukService = ReturnType<typeof createBukService>;

async function collectJobs(client: BukHttpClient, employeeId: string, budget: ToolBudget, maxRecords: number): Promise<CollectionResult<ReturnType<typeof projectJob>>> {
  const path = `/employees/${employeeId}/jobs`;
  const query: Query = {};
  const records: ReturnType<typeof projectJob>[] = [];
  const signatures = new Set<string>();
  const nextLinks = new Set<string>();
  const warnings: string[] = ['JobResponseCountry no publica un id de trabajo; se conservan las filas sin deduplicarlas por trabajo.'];
  let totalCount: number | null = null;
  let countsConsistent = true;
  let complete = true;
  let endedWithExplicitNull = false;
  let pagesRead = 0;
  let declaredPages: number | null = null;
  let next: string | null | undefined;
  let first = true;
  while (first || next !== null) {
    first = false;
    let raw: unknown;
    try {
      raw = typeof next === 'string'
        ? await client.getNextPage(next, path, query, budget.requestOptions())
        : await client.get(path, query, budget.requestOptions());
    } catch (error) {
      if (error instanceof BukServiceError && error.code === 'BUK_BUDGET_EXCEEDED') {
        complete = false;
        warnings.push('Se alcanzó el presupuesto de llamadas o tiempo; el historial es parcial e incompleto.');
        break;
      }
      throw error;
    }
    const page = parsePage(raw, false);
    pagesRead += 1;
    if (page.pagination?.total_pages !== undefined) {
      if (declaredPages !== null && declaredPages !== page.pagination.total_pages) countsConsistent = false;
      declaredPages = page.pagination.total_pages;
    }
    const projected = page.items.map(projectJob);
    const signature = recordSignature(projected);
    if (signatures.has(signature)) {
      complete = false;
      warnings.push('Se detectó una página de trabajos repetida; el historial no se considera final.');
      break;
    }
    signatures.add(signature);
    if (page.pagination?.count !== undefined) {
      if (totalCount !== null && totalCount !== page.pagination.count) countsConsistent = false;
      totalCount = page.pagination.count;
    }
    for (const job of projected) {
      if (records.length >= maxRecords) {
        complete = false;
        warnings.push('Se alcanzó el límite de registros; el historial es parcial e incompleto.');
        break;
      }
      records.push(job);
    }
    if (!complete) break;
    next = page.pagination?.next;
    if (typeof next === 'string') {
      client.validateNextPage(next, path, query);
      if (nextLinks.has(next) || !budget.canContinue()) {
        complete = false;
        warnings.push(nextLinks.has(next) ? 'Se detectó un ciclo de paginación.' : 'Se alcanzó el presupuesto de llamadas o tiempo; el historial es parcial e incompleto.');
        break;
      }
      nextLinks.add(next);
    } else if (next === null) {
      endedWithExplicitNull = true;
      break;
    } else {
      complete = false;
      break;
    }
  }
  if (!countsConsistent) {
    complete = false;
    warnings.push('La paginación cambió durante el recorrido; no hay snapshot transaccional confirmado.');
  }
  if (declaredPages !== null && pagesRead !== declaredPages) {
    complete = false;
    warnings.push('El total de páginas informado por BUK no coincide con las páginas recorridas.');
  }
  if (totalCount === null || records.length !== totalCount || !endedWithExplicitNull) complete = false;
  if (totalCount === null || records.length !== totalCount) addCountWarning(warnings, totalCount, records.length, 'filas de trabajos devueltas');
  return { records, complete, totalCount, warnings };
}
