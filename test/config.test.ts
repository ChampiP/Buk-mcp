import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('configuration reads only declared BUK variables from the given environment and excludes unrelated credentials', () => {
  const config = loadConfig({
    environment: { BUK_AUTH_TOKEN: 'process-fake-token', BUK_HTTP_TIMEOUT_MS: '7000', OTHER_CREDENTIAL: 'also-private', BUK_ALLOW_SALARY: 'false' },
  });
  assert.equal(config.authToken, 'process-fake-token');
  assert.equal(config.timeoutMs, 7000);
  assert.equal(Object.hasOwn(config, 'allowSalary'), false);
  assert.deepEqual(Object.keys(config).sort(), ['authToken', 'baseUrl', 'maxCalls', 'maxRecords', 'maxRetries', 'maxResponseBytes', 'maxToolOutputBytes', 'timeoutMs', 'toolTimeoutMs'].sort());
  assert.equal(JSON.stringify(config).includes('also-private'), false);
});

test('missing token and unsafe base URL fail with sanitized variable names', () => {
  assert.throws(() => loadConfig({ environment: { BUK_AUTH_TOKEN: 'secret-token', BUK_BASE_URL: 'https://attacker.invalid/api/v1/peru' } }), (error: unknown) => {
    assert.equal(String(error).includes('secret-token'), false);
    assert.match(String(error), /BUK_BASE_URL/);
    return true;
  });
  assert.throws(() => loadConfig({ environment: {} }), (error: unknown) => {
    assert.match(String(error), /BUK_AUTH_TOKEN/);
    return true;
  });
});

test('configuration rejects out-of-range runtime limits', () => {
  for (const value of ['0', '999999']) {
    assert.throws(() => loadConfig({ environment: { BUK_AUTH_TOKEN: 'fake', BUK_HTTP_TIMEOUT_MS: value } }));
  }
});
