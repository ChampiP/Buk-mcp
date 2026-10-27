import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BukHttpClient, type Query } from '../src/client.js';

const BASE = 'https://medsculp.buk.pe/api/v1/peru';
type Seen = { url: URL; method: string | undefined };

function harness(body: unknown = { data: [], pagination: { next: null, count: 0, total_pages: 1 } }) {
  const seen: Seen[] = [];
  const client = new BukHttpClient({
    authToken: 'fake-route-token',
    fetcher: async (input, init) => {
      seen.push({ url: new URL(String(input)), method: init?.method });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, seen };
}

async function denied(client: BukHttpClient, path: string, query: Query = {}, code = /BUK_(ROUTE|QUERY)_DENIED/): Promise<void> {
  await assert.rejects(client.get(path, query), (error: unknown) => {
    assert.match(String((error as { code?: string }).code), code);
    return true;
  });
}

test('every registered GET route is reachable with only GET and its documented query', async () => {
  const { client, seen } = harness();
  await client.get('/roles', { search: 'x', page_size: 25 });
  await client.get('/roles/12');
  await client.get('/vacations', { date: '2026-01-01', page_size: 50 });
  await client.get('/absences/permission/types', { with_pay: true });
  await client.get('/employees/7/statements/2026-3.pdf').catch(() => undefined);
  assert.deepEqual(seen.map((request) => request.method), ['GET', 'GET', 'GET', 'GET', 'GET']);
  assert.equal(seen[0]?.url.href, `${BASE}/roles?search=x&page_size=25`);
  assert.equal(seen[1]?.url.pathname, '/api/v1/peru/roles/12');
  assert.equal(seen[3]?.url.searchParams.get('with_pay'), 'true');
  assert.equal(seen[4]?.url.pathname, '/api/v1/peru/employees/7/statements/2026-3.pdf');
});

test('unregistered routes, traversal and wrongly typed path parameters are rejected before any request', async () => {
  const { client, seen } = harness();
  await denied(client, '/employees/1/salary');
  await denied(client, '/roles/1/../users');
  await denied(client, '/roles/%2e%2e');
  await denied(client, '/roles/abc');
  await denied(client, '/roles/01');
  await denied(client, '/employees/7/statements/20x6-3.pdf');
  await denied(client, '/roles?x=1');
  assert.equal(seen.length, 0);
});

test('unknown, mistyped and out-of-enum query values are rejected before any request', async () => {
  const { client, seen } = harness();
  await denied(client, '/roles', { unknown: 'x' });
  await denied(client, '/roles', { page_size: 0 });
  await denied(client, '/roles', { page_size: 101 });
  await denied(client, '/roles', { search: 'a'.repeat(257) });
  await denied(client, '/vacations', { date: '01/01/2026' });
  await denied(client, '/absences/permission/types', { with_pay: 'yes' });
  assert.equal(seen.length, 0);
});

test('multi-valued array parameters repeat the key; arrays without a published encoding are denied', async () => {
  const { client, seen } = harness();
  await client.get('/recruiting/applicants/', { 'selection_processes[]': [3, 5] });
  assert.equal(seen[0]?.url.search, '?selection_processes%5B%5D=3&selection_processes%5B%5D=5');
  await denied(client, '/employees/overtimes', { employees_id: [1, 2] });
  await denied(client, '/recruiting/applicants/', { 'selection_processes[]': ['a'] as unknown as number[] });
});

test('required query parameters are enforced from the registry', async () => {
  const { client } = harness();
  await denied(client, '/employees/active', { date: '2026-01-01' });
});

test('pagination links on generic routes must keep origin, path and filters', async () => {
  const { client } = harness();
  const ok = `${BASE}/roles?search=x&page_size=25&page=2`;
  client.validateNextPage(ok, '/roles', { search: 'x', page_size: 25 });
  assert.throws(() => client.validateNextPage(`${BASE}/roles?search=y&page_size=25&page=2`, '/roles', { search: 'x', page_size: 25 }), /pagination link/);
  assert.throws(() => client.validateNextPage('https://evil.example/api/v1/peru/roles?page=2', '/roles', {}), /pagination link/);
  assert.throws(() => client.validateNextPage(`${BASE}/users?page=2`, '/roles', {}), /pagination link/);
});
