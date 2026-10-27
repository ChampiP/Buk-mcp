import { API_BASE_URL } from './config.js';
import { BukServiceError } from './errors.js';
import { appendQuery, matchRoute, parseQuery, sameValue, validateQuery, type Query } from './routes.js';

export type { Query, QueryValue } from './routes.js';
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RequestBudget {
  signal?: AbortSignal;
  beforeAttempt?: () => void;
  remainingMs?: () => number;
}

export interface BukHttpClientOptions {
  authToken: string;
  baseUrl?: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
}

const continuationKeys = new Set(['page', 'page_size']);

function fail(message: string, code: string): never {
  throw new BukServiceError(message, code);
}

function validateNextUrl(next: string, path: string, originalQuery: Query): URL {
  if (next.length > 2048 || next.includes('\\') || /%(?:2f|5c|2e)/i.test(next)) {
    return fail('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
  }
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return fail('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
  }
  if (url.protocol !== 'https:' || url.origin !== 'https://medsculp.buk.pe' || url.username || url.password || url.hash || url.pathname !== `${new URL(API_BASE_URL).pathname}${path}`) {
    return fail('BUK pagination link is not allowed', 'BUK_PAGINATION_DENIED');
  }
  const route = matchRoute(path);
  const query = parseQuery(route, url);
  validateQuery(route, query, true);
  const keys = new Set([...Object.keys(originalQuery), ...Object.keys(query)]);
  for (const key of keys) {
    if (key === 'page') {
      if (originalQuery.page !== undefined && query.page === undefined) return fail('BUK pagination link changed its page', 'BUK_PAGINATION_DENIED');
      continue;
    }
    if (key === 'page_size') {
      if (originalQuery.page_size !== undefined && originalQuery.page_size !== query.page_size) return fail('BUK pagination link changed its page size', 'BUK_PAGINATION_DENIED');
      continue;
    }
    if (!sameValue(originalQuery[key], query[key])) return fail('BUK pagination link changed its filters', 'BUK_PAGINATION_DENIED');
  }
  for (const key of Object.keys(query)) {
    if (!Object.hasOwn(originalQuery, key) && !continuationKeys.has(key)) return fail('BUK pagination link changed its filters', 'BUK_PAGINATION_DENIED');
  }
  return url;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 1000);
  }
  return Math.min(100 * (2 ** attempt), 1000);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) fail('BUK request cancelled', 'BUK_CANCELLED');
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BukServiceError('BUK request cancelled', 'BUK_CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    fail('BUK response exceeded the size limit', 'BUK_RESPONSE_TOO_LARGE');
  }
  if (!response.body) fail('BUK returned an empty or invalid JSON response', 'BUK_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        fail('BUK response exceeded the size limit', 'BUK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BukServiceError) throw error;
    fail('BUK response body could not be read', 'BUK_NETWORK_ERROR');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return fail('BUK returned an invalid JSON response', 'BUK_RESPONSE_INVALID');
  }
}

export class BukHttpClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;

  constructor(options: BukHttpClientOptions) {
    if (!options.authToken.trim()) fail('BUK_AUTH_TOKEN is required', 'BUK_CONFIG_MISSING');
    if (options.authToken !== options.authToken.trim() || /[\r\n\0]/.test(options.authToken)) fail('BUK_AUTH_TOKEN contains unsupported whitespace or control characters', 'BUK_CONFIG_INVALID');
    if (options.baseUrl !== undefined && options.baseUrl !== API_BASE_URL) fail('BUK_BASE_URL must match the approved BUK API origin', 'BUK_CONFIG_INVALID');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) fail('BUK timeout is outside the supported range', 'BUK_CONFIG_INVALID');
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 2) fail('BUK retry limit is outside the supported range', 'BUK_CONFIG_INVALID');
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 1_048_576) fail('BUK response limit is outside the supported range', 'BUK_CONFIG_INVALID');
    this.authToken = options.authToken;
  }

  private readonly authToken: string;

  async get(path: string, query: Query = {}, budget: RequestBudget = {}): Promise<unknown> {
    validateQuery(matchRoute(path), query);
    const url = new URL(`${API_BASE_URL}${path}`);
    appendQuery(url, query);
    return this.request(url, budget);
  }

  validateNextPage(next: string, path: string, originalQuery: Query): void {
    validateNextUrl(next, path, originalQuery);
  }

  async getNextPage(next: string, path: string, originalQuery: Query, budget: RequestBudget = {}): Promise<unknown> {
    const url = validateNextUrl(next, path, originalQuery);
    return this.request(url, budget);
  }

  private async request(url: URL, budget: RequestBudget): Promise<unknown> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (budget.signal?.aborted) fail('BUK request cancelled', 'BUK_CANCELLED');
      budget.beforeAttempt?.();
      const remaining = budget.remainingMs?.();
      if (remaining !== undefined && remaining <= 0) fail('BUK tool time limit reached', 'BUK_BUDGET_EXCEEDED');
      const timeout = Math.max(1, Math.min(this.timeoutMs, remaining ?? this.timeoutMs));
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      budget.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        budget.signal?.removeEventListener('abort', onAbort);
      };
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json', auth_token: this.authToken },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        cleanup();
        if (budget.signal?.aborted) fail('BUK request cancelled', 'BUK_CANCELLED');
        if (attempt < this.maxRetries) {
          const delay = Math.min(retryDelay(undefined, attempt), budget.remainingMs?.() ?? 1000);
          await wait(delay, budget.signal);
          continue;
        }
        fail(timedOut ? 'BUK request timed out' : 'BUK network request failed', timedOut ? 'BUK_TIMEOUT' : 'BUK_NETWORK_ERROR');
      }

      try {
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          fail('BUK redirect responses are not allowed', 'BUK_REDIRECT_DENIED');
        }
        if (response.url) {
          try {
            if (new URL(response.url).href !== url.href) fail('BUK response came from an unexpected URL', 'BUK_REDIRECT_DENIED');
          } catch (error) {
            if (error instanceof BukServiceError) throw error;
            fail('BUK response came from an unexpected URL', 'BUK_REDIRECT_DENIED');
          }
        }
        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          const delay = retryDelay(response, attempt);
          await response.body?.cancel().catch(() => undefined);
          cleanup();
          if (attempt < this.maxRetries) {
            await wait(Math.min(delay, budget.remainingMs?.() ?? 1000), budget.signal);
            continue;
          }
          fail(`BUK returned HTTP ${response.status}`, `BUK_HTTP_${response.status}`);
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          fail(`BUK returned HTTP ${response.status}`, `BUK_HTTP_${response.status}`);
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
          await response.body?.cancel().catch(() => undefined);
          fail('BUK returned a non-JSON response', 'BUK_RESPONSE_INVALID');
        }
        try {
          return await readJson(response, this.maxResponseBytes);
        } catch (error) {
          if (budget.signal?.aborted) fail('BUK request cancelled', 'BUK_CANCELLED');
          if (timedOut) {
            if (attempt < this.maxRetries) {
              cleanup();
              await wait(Math.min(retryDelay(undefined, attempt), budget.remainingMs?.() ?? 1000), budget.signal);
              continue;
            }
            fail('BUK request timed out', 'BUK_TIMEOUT');
          }
          if (error instanceof BukServiceError && error.code === 'BUK_NETWORK_ERROR') {
            if (attempt < this.maxRetries) {
              cleanup();
              await wait(Math.min(retryDelay(undefined, attempt), budget.remainingMs?.() ?? 1000), budget.signal);
              continue;
            }
            fail('BUK network request failed', 'BUK_NETWORK_ERROR');
          }
          throw error;
        }
      } finally {
        cleanup();
      }
    }
    return fail('BUK request could not be completed', 'BUK_REQUEST_FAILED');
  }
}
