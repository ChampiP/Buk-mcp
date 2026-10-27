import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BukHttpClient } from '../src/client.js';
import { DOMAINS } from '../src/domains.generated.js';
import { OPERATIONS } from '../src/operations.generated.js';
import { buildDomainInputSchema, domainToolNames, operationName } from '../src/domain-tools.js';
import { createDomainService } from '../src/domain-service.js';
import { createBukMcpServer } from '../src/server.js';
import { createBukService } from '../src/service.js';

const BASE = 'https://medsculp.buk.pe/api/v1/peru';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function domainHarness(responses: unknown[] | ((url: URL) => unknown), limits: { maxToolOutputBytes?: number; maxRecords?: number; maxCalls?: number } = {}) {
  const urls: URL[] = [];
  let index = 0;
  const client = new BukHttpClient({
    authToken: 'fake-domain-token',
    fetcher: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return json(typeof responses === 'function' ? responses(url) : responses[Math.min(index++, responses.length - 1)]);
    },
  });
  return { service: createDomainService({ client, now: () => new Date('2026-10-27T12:00:00Z'), ...limits }), urls, client };
}

test('operation names are deterministic, unique per tool and cover every domain operation', () => {
  assert.equal(operationName('/roles/{id}'), 'roles_by_id');
  assert.equal(operationName('/vacations/business_days'), 'vacations_business_days');
  assert.equal(operationName('/employees/{id}/statements/{year}-{month}.pdf'), 'employees_by_id_statements_by_year_by_month_pdf');
  const known = new Set(OPERATIONS.map((operation) => operation.path));
  for (const [tool, domain] of Object.entries(DOMAINS)) {
    const names = domain.operations.map(operationName);
    assert.equal(new Set(names).size, names.length, `${tool} has colliding operation names`);
    for (const path of domain.operations) assert.ok(known.has(path), path);
  }
  assert.equal(domainToolNames().length, 19);
  assert.ok(!domainToolNames().some((name) => DOMAINS[name]?.phaseOne));
});

test('every domain input schema accepts only its own operations with strictly typed parameters', () => {
  for (const tool of domainToolNames()) buildDomainInputSchema(tool);
  const schema = buildDomainInputSchema('buk_org_catalogs');
  assert.ok(schema.safeParse({ request: { operation: 'roles_by_id', id: '5' } }).success);
  assert.ok(schema.safeParse({ request: { operation: 'roles', search: 'x', page_size: 25 } }).success);
  assert.ok(!schema.safeParse({ request: { operation: 'roles_by_id' } }).success, 'missing required id');
  assert.ok(!schema.safeParse({ request: { operation: 'roles_by_id', id: 'abc' } }).success, 'non numeric id');
  assert.ok(!schema.safeParse({ request: { operation: 'roles', unknown: 1 } }).success, 'unknown key');
  assert.ok(!schema.safeParse({ request: { operation: 'users' } }).success, 'operation of another tool');
  assert.ok(!schema.safeParse({ request: { operation: 'roles', page_size: 101 } }).success, 'page_size bound');
  const recruiting = buildDomainInputSchema('buk_recruiting');
  assert.ok(recruiting.safeParse({ request: { operation: 'recruiting_applicants', selection_processes: [3, 5] } }).success);
});

test('a paginated list returns one page with explicit completeness and the requested filters only', async () => {
  const { service, urls } = domainHarness([{ data: [{ id: 1 }, { id: 2 }], pagination: { next: null, count: 2, total_pages: 1 } }]);
  const out = await service.query('buk_org_catalogs', { request: { operation: 'roles', search: 'x', page_size: 25 } });
  assert.equal(urls[0]?.href, `${BASE}/roles?search=x&page_size=25`);
  assert.equal(out.operation, 'roles');
  assert.deepEqual(out.data, [{ id: 1 }, { id: 2 }]);
  assert.equal(out.meta.complete, true);
  assert.equal(out.meta.returned_count, 2);
  assert.equal(out.meta.total_count, 2);
  assert.equal(out.meta.upstream_calls, 1);
});

test('more pages upstream makes a single-page result incomplete and says how to continue', async () => {
  const { service } = domainHarness([{ data: [{ id: 1 }], pagination: { next: `${BASE}/roles?page_size=25&page=2`, count: 40, total_pages: 2 } }]);
  const out = await service.query('buk_org_catalogs', { request: { operation: 'roles', page_size: 25 } });
  assert.equal(out.meta.complete, false);
  assert.match(out.warnings.join(' '), /all_pages/);
});

test('all_pages follows validated next links within the call budget and reports completeness', async () => {
  const pages = [
    { data: [{ id: 1 }], pagination: { next: `${BASE}/roles?page_size=25&page=2`, count: 2, total_pages: 2 } },
    { data: [{ id: 2 }], pagination: { next: null, count: 2, total_pages: 2 } },
  ];
  const { service, urls } = domainHarness(pages);
  const out = await service.query('buk_org_catalogs', { request: { operation: 'roles', page_size: 25, all_pages: true } });
  assert.equal(urls.length, 2);
  assert.deepEqual(out.data, [{ id: 1 }, { id: 2 }]);
  assert.equal(out.meta.complete, true);
  const budget = domainHarness(() => ({ data: [{ id: 1 }], pagination: { next: `${BASE}/roles?page_size=25&page=2`, count: 99 } }), { maxCalls: 1 });
  const partial = await budget.service.query('buk_org_catalogs', { request: { operation: 'roles', page_size: 25, all_pages: true } });
  assert.equal(partial.meta.complete, false);
  assert.equal(partial.meta.upstream_calls, 1);
});

test('a manipulated next link is rejected before the token is sent anywhere', async () => {
  const { service, urls } = domainHarness([{ data: [{ id: 1 }], pagination: { next: 'https://evil.example/api/v1/peru/roles?page=2' } }]);
  await assert.rejects(service.query('buk_org_catalogs', { request: { operation: 'roles', page_size: 25, all_pages: true } }), /pagination link/);
  assert.equal(urls.length, 1);
});

test('single objects, data-wrapped objects and bare arrays are accepted; schema-less operations carry a warning', async () => {
  const one = await domainHarness([{ data: { id: 5, name: 'Rol' } }]).service.query('buk_org_catalogs', { request: { operation: 'roles_by_id', id: '5' } });
  assert.deepEqual(one.data, { id: 5, name: 'Rol' });
  const bare = await domainHarness([{ id: 5 }]).service.query('buk_org_catalogs', { request: { operation: 'roles_by_id', id: '5' } });
  assert.deepEqual(bare.data, { id: 5 });
  const noSchema = await domainHarness([{ data: [] }]).service.query('buk_piecework', { request: { operation: 'piecework_tasks' } });
  assert.match(noSchema.warnings.join(' '), /esquema de respuesta/i);
});

test('invalid requests and unknown tools fail with sanitized argument errors and no request', async () => {
  const { service, urls } = domainHarness([{}]);
  await assert.rejects(service.query('buk_org_catalogs', { request: { operation: 'roles_by_id' } }), (error: unknown) => (error as { code?: string }).code === 'BUK_INVALID_ARGUMENT');
  await assert.rejects(service.query('buk_nope', {}), (error: unknown) => (error as { code?: string }).code === 'BUK_INVALID_ARGUMENT');
  assert.equal(urls.length, 0);
});

test('oversized output is truncated explicitly instead of overflowing', async () => {
  const rows = Array.from({ length: 200 }, (_, id) => ({ id, name: 'x'.repeat(40) }));
  const { service } = domainHarness([{ data: rows, pagination: { next: null, count: 200 } }], { maxToolOutputBytes: 4096 });
  const out = await service.query('buk_org_catalogs', { request: { operation: 'roles', page_size: 100 } });
  assert.equal(out.meta.complete, false);
  assert.ok(out.meta.returned_count < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4096);
  assert.match(out.warnings.join(' '), /recort|trunc/i);
});

test('the MCP server exposes the three phase-one tools plus one read-only tool per domain, sensitive ones labelled', async () => {
  const client = new BukHttpClient({ authToken: 'fake', fetcher: async () => json({ data: { id: 9, name: 'Rol' } }) });
  const server = createBukMcpServer(createBukService({ client }), createDomainService({ client }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: 'domain-test', version: '1.0.0' });
  await mcp.connect(a);
  const tools = (await mcp.listTools()).tools;
  assert.equal(tools.length, 22);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.inputSchema.type === 'object'));
  for (const tool of tools) if (DOMAINS[tool.name]?.sensitive) assert.match(tool.description ?? '', /sensible/i, tool.name);
  const result = await mcp.callTool({ name: 'buk_org_catalogs', arguments: { request: { operation: 'roles_by_id', id: '9' } } });
  assert.equal(result.isError, undefined);
  assert.deepEqual((result.structuredContent as { data: unknown }).data, { id: 9, name: 'Rol' });
  const bad = await mcp.callTool({ name: 'buk_org_catalogs', arguments: { request: { operation: 'roles_by_id' } } });
  assert.equal(bad.isError, true);
  await mcp.close();
  await server.close();
});

test('list envelopes keyed by a collection name (not `data`) are read as lists and stay paginated', async () => {
  const pages = [
    { pagination: { next: `${BASE}/recruiting/applicants/?page=2`, count: 2, total_pages: 2 }, applicants: [{ id: 1 }] },
    { pagination: { next: null, count: 2, total_pages: 2 }, applicants: [{ id: 2 }] },
  ];
  const single = await domainHarness([pages[0]]).service.query('buk_recruiting', { request: { operation: 'recruiting_applicants' } });
  assert.deepEqual(single.data, [{ id: 1 }]);
  assert.equal(single.meta.complete, false);
  const { service, urls } = domainHarness(pages);
  const all = await service.query('buk_recruiting', { request: { operation: 'recruiting_applicants', all_pages: true } });
  assert.deepEqual(all.data, [{ id: 1 }, { id: 2 }]);
  assert.equal(all.meta.complete, true);
  assert.equal(urls.length, 2);
});

test('a single object that carries a paginated sub-list with more pages is never reported complete', async () => {
  const { service } = domainHarness([{ id: 3, name: 'G', pagination: { next: `${BASE}/groups/3?page=2`, count: 80 }, participants: [{ id: 1 }] }]);
  const out = await service.query('buk_organization', { request: { operation: 'groups_by_id', id: '3' } });
  assert.equal(out.meta.complete, false);
  assert.match(out.warnings.join(' '), /sub-?lista|más páginas/i);
});
