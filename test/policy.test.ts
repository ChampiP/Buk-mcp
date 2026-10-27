import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BukHttpClient } from '../src/client.js';
import { createDomainService } from '../src/domain-service.js';
import { buildDomainInputSchema } from '../src/domain-tools.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const delayed = (ms: number, signal: AbortSignal | null | undefined, body: unknown) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(json(body)), ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
});

test('a measured-slow operation gets a longer attempt timeout and no retries; other routes keep the short timeout', async () => {
  let calls = 0;
  const client = new BukHttpClient({ authToken: 'fake-policy-token', timeoutMs: 20, fetcher: (_url, init) => { calls += 1; return delayed(80, init?.signal, { data: [] }); } });
  await assert.rejects(client.get('/roles'), (error: unknown) => (error as { code?: string }).code === 'BUK_TIMEOUT');
  assert.equal(calls, 3, 'regular routes retry twice after the short timeout');
  calls = 0;
  await client.get('/accounting', { month: 9, year: 2026 });
  assert.equal(calls, 1);
  calls = 0;
  const failing = new BukHttpClient({ authToken: 'fake-policy-token', fetcher: async () => { calls += 1; throw new Error('network'); } });
  await assert.rejects(failing.get('/accounting', { month: 9, year: 2026 }));
  assert.equal(calls, 1, 'slow operations are not retried');
});

test('operations BUK rejects without certain parameters require them in the schema and in the client', async () => {
  const accounting = buildDomainInputSchema('buk_accounting');
  assert.equal(accounting.safeParse({ request: { operation: 'accounting' } }).success, false);
  assert.equal(accounting.safeParse({ request: { operation: 'accounting', month: 9, year: 2026 } }).success, true);
  assert.equal(accounting.safeParse({ request: { operation: 'accounting_structure_assignments' } }).success, false);
  assert.equal(accounting.safeParse({ request: { operation: 'accounting_structure_assignments', empresa_id: 1 } }).success, true);
  const client = new BukHttpClient({ authToken: 'fake-policy-token', fetcher: async () => json({}) });
  await assert.rejects(client.get('/accounting', { month: 9 }), (error: unknown) => (error as { code?: string }).code === 'BUK_QUERY_DENIED');
});

test('domain tools explain upstream failures so the agent can recover', async () => {
  const run = async (status: number) => {
    const client = new BukHttpClient({ authToken: 'fake-policy-token', fetcher: async () => new Response('{}', { status, headers: { 'content-type': 'application/json', location: 'https://files.example/x' } }) });
    return createDomainService({ client }).query('buk_org_catalogs', { request: { operation: 'roles_by_id', id: '5' } }).then(() => '', (error: Error) => error.message);
  };
  assert.match(await run(404), /no existe|no hay datos/i);
  assert.match(await run(403), /permiso/i);
  assert.match(await run(401), /token/i);
  assert.match(await run(400), /par[aá]metros/i);
  assert.match(await run(302), /redirecci[oó]n/i);
  assert.equal((await run(404)).includes('fake-policy-token'), false);
});
