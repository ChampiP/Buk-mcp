import { BukServiceError } from './errors.js';

export const API_BASE_URL = 'https://medsculp.buk.pe/api/v1/peru';

export interface BukConfig {
  baseUrl: typeof API_BASE_URL;
  authToken: string;
  timeoutMs: number;
  maxRetries: number;
  maxCalls: number;
  maxRecords: number;
  toolTimeoutMs: number;
  maxResponseBytes: number;
  maxToolOutputBytes: number;
}

export interface LoadConfigOptions {
  environment?: Record<string, string | undefined>;
}

const variableNames = [
  'BUK_AUTH_TOKEN', 'BUK_BASE_URL', 'BUK_HTTP_TIMEOUT_MS',
  'BUK_MAX_RETRIES', 'BUK_TOOL_MAX_CALLS', 'BUK_TOOL_MAX_RECORDS', 'BUK_TOOL_TIMEOUT_MS',
  'BUK_MAX_RESPONSE_BYTES', 'BUK_MAX_TOOL_OUTPUT_BYTES',
] as const;

type BUKVariable = typeof variableNames[number];

function boundedInteger(values: Record<string, string | undefined>, name: BUKVariable, fallback: number, min: number, max: number): number {
  const value = values[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new BukServiceError(`${name} must be an integer from ${min} to ${max}`, 'BUK_CONFIG_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new BukServiceError(`${name} must be an integer from ${min} to ${max}`, 'BUK_CONFIG_INVALID');
  return parsed;
}

export function loadConfig(options: LoadConfigOptions = {}): BukConfig {
  const environment = options.environment ?? process.env;
  const values: Record<string, string | undefined> = {};
  for (const name of variableNames) values[name] = environment[name];

  const authToken = values.BUK_AUTH_TOKEN?.trim();
  if (!authToken) throw new BukServiceError('Missing required BUK_AUTH_TOKEN; set it in the MCP host server environment.', 'BUK_CONFIG_MISSING');
  if (authToken !== values.BUK_AUTH_TOKEN || /[\r\n\0]/.test(authToken)) throw new BukServiceError('BUK_AUTH_TOKEN contains unsupported whitespace or control characters', 'BUK_CONFIG_INVALID');
  if (values.BUK_BASE_URL !== undefined && values.BUK_BASE_URL !== '' && values.BUK_BASE_URL !== API_BASE_URL) {
    throw new BukServiceError('BUK_BASE_URL must match the approved BUK API base URL.', 'BUK_CONFIG_INVALID');
  }
  return {
    baseUrl: API_BASE_URL,
    authToken,
    timeoutMs: boundedInteger(values, 'BUK_HTTP_TIMEOUT_MS', 15_000, 1, 15_000),
    maxRetries: boundedInteger(values, 'BUK_MAX_RETRIES', 2, 0, 2),
    maxCalls: boundedInteger(values, 'BUK_TOOL_MAX_CALLS', 50, 1, 50),
    maxRecords: boundedInteger(values, 'BUK_TOOL_MAX_RECORDS', 5000, 1, 5000),
    toolTimeoutMs: boundedInteger(values, 'BUK_TOOL_TIMEOUT_MS', 60_000, 1, 60_000),
    maxResponseBytes: boundedInteger(values, 'BUK_MAX_RESPONSE_BYTES', 1_048_576, 1024, 1_048_576),
    maxToolOutputBytes: boundedInteger(values, 'BUK_MAX_TOOL_OUTPUT_BYTES', 100_000, 2048, 100_000),
  };
}

export function loadRuntimeConfig(): BukConfig {
  return loadConfig();
}
