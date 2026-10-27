import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const spec = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec');
const read = (name: string) => JSON.parse(readFileSync(join(spec, name), 'utf8'));
const registry = read('buk-peru-get.registry.json') as { operations: { path: string; parameters: { in: string }[] }[]; unresolved_refs: string[] };
const domains = read('domains.json').domains as Record<string, { operations: string[] }>;

test('registry holds the 119 published GET operations with unique paths and only path/query parameters', () => {
  assert.equal(registry.operations.length, 119);
  assert.equal(new Set(registry.operations.map((operation) => operation.path)).size, 119);
  for (const operation of registry.operations) {
    assert.match(operation.path, /^\/[A-Za-z0-9_\-/{}.]+$/);
    for (const parameter of operation.parameters) assert.ok(parameter.in === 'path' || parameter.in === 'query', `${operation.path}: ${parameter.in}`);
  }
});

test('every registry operation belongs to exactly one tool and no tool lists an unknown route', () => {
  const owners = new Map<string, string[]>();
  for (const [tool, domain] of Object.entries(domains)) for (const path of domain.operations) owners.set(path, [...(owners.get(path) ?? []), tool]);
  assert.deepEqual([...owners.keys()].sort(), registry.operations.map((operation) => operation.path).sort());
  for (const [path, tools] of owners) assert.equal(tools.length, 1, `${path} owned by ${tools.join(',')}`);
});

test('the three phase-one tools keep their documented routes', () => {
  assert.deepEqual(domains.buk_workforce_summary?.operations, ['/employees/active']);
  assert.deepEqual(domains.buk_employees_search?.operations, ['/employees']);
  assert.deepEqual([...(domains.buk_employee_context?.operations ?? [])].sort(), ['/employees/{id}', '/employees/{id}/jobs']);
});

test('the only unresolved Swagger reference is the known missing accounting definition', () => {
  assert.deepEqual(registry.unresolved_refs, ['CuentaContable']);
});
