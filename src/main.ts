#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BukHttpClient } from './client.js';
import { loadRuntimeConfig, type BukConfig } from './config.js';
import { safeErrorMessage } from './errors.js';
import { createBukMcpServer } from './server.js';
import { createBukService } from './service.js';

export async function main(): Promise<void> {
  let config: BukConfig;
  try {
    config = loadRuntimeConfig();
  } catch (error) {
    process.stderr.write(`BUK MCP: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const client = new BukHttpClient({
    authToken: config.authToken,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxResponseBytes: config.maxResponseBytes,
  });
  const service = createBukService({
    client,
    maxCalls: config.maxCalls,
    maxRecords: config.maxRecords,
    toolTimeoutMs: config.toolTimeoutMs,
    maxToolOutputBytes: config.maxToolOutputBytes,
  });
  const server = createBukMcpServer(service);
  try {
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write('BUK MCP: no se pudo iniciar el transporte stdio.\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(realpathSync(invokedPath)).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write('BUK MCP: error interno al iniciar.\n');
    process.exitCode = 1;
  });
}
