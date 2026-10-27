import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BukHttpClient } from '../src/client.js';
import { createBukService } from '../src/service.js';

function serviceFor(body: unknown) {
  const client = new BukHttpClient({ authToken: 'fake-search-token', fetcher: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });
  return createBukService({ client });
}

test('a search with no matches is complete: BUK reports total_pages 0 and no next page', async () => {
  const out = await serviceFor({ data: [], pagination: { next: null, previous: null, count: 0, total_pages: 0 } }).employeesSearch({ document_number: '00000000' });
  assert.equal(out.meta.complete, true);
  assert.equal(out.meta.returned_count, 0);
  assert.deepEqual(out.data.candidates, []);
});

test('a search whose single page is full stays complete, and more pages stay incomplete', async () => {
  const row = (id: number) => ({ id, full_name: `Synthetic ${id}`, status: 'activo' });
  const one = await serviceFor({ data: [row(1), row(2)], pagination: { next: null, count: 2, total_pages: 1 } }).employeesSearch({ status: 'activo' });
  assert.equal(one.meta.complete, true);
  const more = await serviceFor({ data: [row(1)], pagination: { next: 'https://medsculp.buk.pe/api/v1/peru/employees?status=activo&page=2&page_size=25', count: 1, total_pages: 2 } }).employeesSearch({ status: 'activo' });
  assert.equal(more.meta.complete, false);
});
