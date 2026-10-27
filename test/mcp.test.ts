import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BukHttpClient } from '../src/client.js';
import { createBukMcpServer } from '../src/server.js';
import { createBukService } from '../src/service.js';

const TOKEN = 'fake-token-for-protocol-test';
const BASE = 'https://medsculp.buk.pe/api/v1/peru';
const testDirectory = dirname(fileURLToPath(import.meta.url));

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeService(payload: unknown) {
  const client = new BukHttpClient({ authToken: TOKEN, fetcher: async () => response(payload) });
  return createBukService({ client, now: () => new Date('2026-10-26T12:00:00.000Z') });
}

async function connected(service: ReturnType<typeof createServicePlaceholder>) {
  const server = createBukMcpServer(service);
  const client = new Client({ name: 'buk-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function createServicePlaceholder() {
  return createBukService({ client: new BukHttpClient({ authToken: TOKEN, fetcher: async () => response({}) }) });
}

test('real MCP tools/list and tools/call expose the three closed read-only tools with output schema', async () => {
  const service = makeService({ data: [{ id: 1, full_name: 'Synthetic Person' }], pagination: { count: 1, total_pages: 1, next: null } });
  const { client, server } = await connected(service);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['buk_employee_context', 'buk_employees_search', 'buk_workforce_summary']);
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.openWorldHint, true);
      assert.ok(tool.inputSchema);
      assert.ok(tool.outputSchema);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const summaryTool = listed.tools.find((tool) => tool.name === 'buk_workforce_summary');
    assert.ok(summaryTool);
    assert.ok((summaryTool.inputSchema.required as string[]).includes('as_of'));
    const result = await client.callTool({ name: 'buk_workforce_summary', arguments: { as_of: '2026-10-26' } });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { data?: { count?: number }; meta?: { complete?: boolean; total_count?: number | null; total_count_semantics?: string } } | undefined;
    assert.equal(structured?.data?.count, 1);
    assert.equal(structured?.meta?.complete, true);
    assert.equal(structured?.meta?.total_count, 1);
    assert.match(structured?.meta?.total_count_semantics ?? '', /Computed final unique employee ID total/);
    const text = result.content.find((block) => block.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(JSON.parse(text.text).data.count, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP rejects invalid arguments and includes salary by default with explicit omission', async () => {
  const service = makeService({ data: { id: 9, full_name: 'Synthetic Person', current_job: { base_wage: 5000 } } });
  const { client, server } = await connected(service);
  try {
    const invalid = await client.callTool({ name: 'buk_employee_context', arguments: { employee_id: '../9', other: 'secret-input' } });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.stringify(invalid).includes('secret-input'), false);
    const included = await client.callTool({ name: 'buk_employee_context', arguments: { employee_id: '9', include_jobs: false } });
    assert.equal(included.isError, undefined);
    const data = included.structuredContent as { data: { salary_included: boolean; employee: { salary: { amount: number } } } };
    assert.equal(data.data.salary_included, true);
    assert.equal(data.data.employee.salary.amount, 5000);
    const omitted = await client.callTool({ name: 'buk_employee_context', arguments: { employee_id: '9', include_jobs: false, include_salary: false } });
    assert.equal(omitted.isError, undefined);
    const serialized = JSON.stringify(omitted);
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('5000'), false);
  } finally {
    await client.close();
    await server.close();
  }

  const allowedService = makeService({ id: 10, full_name: 'Synthetic Salary Employee', payment_currency: 'PEN', current_job: { base_wage: 3200 } });
  const allowedConnection = await connected(allowedService);
  try {
    const salary = await allowedConnection.client.callTool({ name: 'buk_employee_context', arguments: { employee_id: '10', include_jobs: false, include_salary: true } });
    assert.equal(salary.isError, undefined);
    const salaryData = salary.structuredContent as { data?: { employee?: { salary?: { amount?: number | null; currency?: null } } } } | undefined;
    assert.equal(salaryData?.data?.employee?.salary?.amount, 3200);
    assert.equal(salaryData?.data?.employee?.salary?.currency, null);
  } finally {
    await allowedConnection.client.close();
    await allowedConnection.server.close();
  }
});

test('stdio subprocess emits protocol on stdout, keeps fake token out of stderr, and exits cleanly on client close', async () => {
  const entry = join(testDirectory, 'stdio-fixture.js');
  const transportModule = await import('@modelcontextprotocol/client/stdio');
  const transport = new transportModule.StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'buk-stdio-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'buk_workforce_summary', arguments: { as_of: '2026-10-26' } });
    assert.equal(result.isError, undefined);
    assert.ok(result.content.some((block) => block.type === 'text'));
  } finally {
    await client.close();
    await transport.close();
  }
  assert.equal(stderr.includes('stdio-fixture-secret'), false);
  assert.equal(stderr.includes(TOKEN), false);
});
