import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BukHttpClient } from '../src/client.js';
import { createDomainService } from '../src/domain-service.js';
import { buildDomainInputSchema } from '../src/domain-tools.js';

const BASE = 'https://medsculp.buk.pe/api/v1/peru';
const TOKEN = 'fake-verifier-secret';
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('requests are GET without a body, to the fixed origin, with redirects disabled; hostile paths are rejected', async () => {
  let calls = 0;
  const client = new BukHttpClient({
    authToken: TOKEN,
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, 'manual');
      assert.equal(new URL(String(url)).origin, 'https://medsculp.buk.pe');
      return json({});
    },
  });
  await client.get('/roles', { search: 'https://evil.example/?_method=POST' });
  await assert.rejects(client.get('/users/%2e%2e'));
  assert.equal(calls, 1);
});

test('domain tool schemas reject unknown keys at the root and inside the request', () => {
  const schema = buildDomainInputSchema('buk_org_catalogs');
  for (const input of [{ request: { operation: 'roles', url: 'https://evil.example' } }, { request: { operation: 'roles' }, method: 'POST' }]) {
    assert.equal(schema.safeParse(input).success, false);
  }
});

test('a pagination link carrying a __proto__ key is rejected before any request', async () => {
  let calls = 0;
  const client = new BukHttpClient({ authToken: TOKEN, fetcher: async () => { calls += 1; return json({}); } });
  await assert.rejects(client.getNextPage(`${BASE}/employees?__proto__=x&page=2`, '/employees', {}));
  await assert.rejects(client.getNextPage(`${BASE}/employees?__proto__=x&__proto__=y&page=2`, '/employees', {}));
  assert.equal(calls, 0);
});

test('a credential echoed by the upstream body is never returned in a tool result', async () => {
  const client = new BukHttpClient({ authToken: TOKEN, fetcher: async () => json({ data: { id: 1, auth_token: TOKEN } }) });
  const output = await createDomainService({ client }).query('buk_users_permissions', { request: { operation: 'users_by_id', id: '1' } });
  assert.equal(JSON.stringify(output).includes(TOKEN), false);
});
