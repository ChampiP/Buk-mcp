import { type RequestBudget } from './client.js';
import { BukServiceError } from './errors.js';

export interface Pagination {
  next?: string | null;
  count?: number;
  total_pages?: number;
}

export interface Page {
  items: Record<string, unknown>[];
  pagination: Pagination | null;
}

export interface CollectionResult<T> {
  records: T[];
  complete: boolean;
  totalCount: number | null;
  warnings: string[];
}

export class ToolBudget {
  private attempts = 0;
  private readonly deadline: number;

  constructor(private readonly maxCalls: number, timeoutMs: number, private readonly signal?: AbortSignal) {
    this.deadline = Date.now() + timeoutMs;
  }

  beforeAttempt = (): void => {
    if (this.signal?.aborted) throw new BukServiceError('BUK request cancelled', 'BUK_CANCELLED');
    if (this.attempts >= this.maxCalls || this.remainingMs() <= 0) throw new BukServiceError('BUK tool budget reached', 'BUK_BUDGET_EXCEEDED');
    this.attempts += 1;
  };

  remainingMs = (): number => Math.max(0, this.deadline - Date.now());

  get calls(): number {
    return this.attempts;
  }

  canContinue(): boolean {
    return this.attempts < this.maxCalls && this.remainingMs() > 0 && !this.signal?.aborted;
  }

  requestOptions(): RequestBudget {
    const options: RequestBudget = { beforeAttempt: this.beforeAttempt, remainingMs: this.remainingMs };
    if (this.signal) return { ...options, signal: this.signal };
    return options;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidEnvelope(): never {
  throw new BukServiceError('BUK response has an unsupported or malformed envelope', 'BUK_RESPONSE_ENVELOPE');
}

export function parsePagination(value: unknown): Pagination | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return invalidEnvelope();
  const allowed = new Set(['next', 'previous', 'count', 'total_pages']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return invalidEnvelope();
  const pagination: Pagination = {};
  if (value.next !== undefined) {
    if (value.next !== null && typeof value.next !== 'string') return invalidEnvelope();
    pagination.next = value.next;
  }
  if (value.count !== undefined) {
    if (!Number.isSafeInteger(value.count) || (value.count as number) < 0) return invalidEnvelope();
    pagination.count = value.count as number;
  }
  if (value.total_pages !== undefined) {
    if (!Number.isSafeInteger(value.total_pages) || (value.total_pages as number) < 0) return invalidEnvelope();
    pagination.total_pages = value.total_pages as number;
  }
  if (value.previous !== undefined && value.previous !== null && typeof value.previous !== 'string') return invalidEnvelope();
  return pagination;
}

export function ensureSmall<T, Result>(records: T[], buildResult: () => Result, maxBytes: number, onTruncate: () => void): Result {
  let truncated = false;
  while (records.length > 0 && Buffer.byteLength(JSON.stringify(buildResult()), 'utf8') > maxBytes) {
    records.pop();
    if (!truncated) {
      truncated = true;
      onTruncate();
    }
  }
  const result = buildResult();
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    throw new BukServiceError('BUK output exceeded the size limit', 'BUK_OUTPUT_TOO_LARGE');
  }
  return result;
}

export function newMeta(now: () => Date, complete: boolean, returnedCount: number, totalCount: number | null, calls: number, totalCountSemantics: string) {
  return {
    source: 'BUK' as const,
    fetched_at: now().toISOString(),
    complete,
    returned_count: returnedCount,
    total_count: totalCount,
    total_count_semantics: totalCountSemantics,
    upstream_calls: calls,
  };
}

