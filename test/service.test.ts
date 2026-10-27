import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BukHttpClient } from '../src/client.js';
import { createBukService, type BukServiceOptions } from '../src/service.js';

const TOKEN = 'fake-buk-token-do-not-print';
const BASE = 'https://medsculp.buk.pe/api/v1/peru';
const date = '2026-10-26';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function employee(id: number, extra: Record<string, unknown> = {}) {
  return { id, full_name: `Synthetic Employee ${id}`, status: 'activo', ...extra };
}

function serviceFor(responses: Array<Response | ((url: URL, init: RequestInit) => Response | Promise<Response>)>, options: Partial<Omit<BukServiceOptions, 'client' | 'now'>> = {}) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const queue = [...responses];
  const client = new BukHttpClient({
    authToken: TOKEN,
    fetcher: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, init });
      const item = queue.shift();
      if (!item) throw new Error('No synthetic response was configured');
      return typeof item === 'function' ? await item(url, init) : item;
    },
  });
  return {
    service: createBukService({ client, now: () => new Date('2026-10-26T12:00:00.000Z'), ...options }),
    requests,
  };
}

test('workforce summary requires an ISO date, defaults pending exclusion, follows pages, and counts unique employee IDs', async () => {
  const next = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=2`;
  const { service, requests } = serviceFor([
    json({ data: [employee(1), employee(2)], pagination: { next, count: 2, total_pages: 2 } }),
    json({ data: [employee(2), employee(3)], pagination: { next: null, count: 2, total_pages: 2 } }),
  ]);

  const result = await service.workforceSummary({ as_of: date });
  assert.equal(result.data.count, 3);
  assert.equal(result.meta.returned_count, 3);
  assert.equal(result.meta.total_count, 3);
  assert.equal(result.meta.complete, true);
  assert.equal(result.meta.upstream_calls, 2);
  assert.deepEqual(requests.map(({ url }) => url.pathname), [`/api/v1/peru/employees/active`, `/api/v1/peru/employees/active`]);
  assert.equal(requests[0]?.url.searchParams.get('exclude_pending'), 'true');
  assert.equal(requests[0]?.url.searchParams.get('page'), null);
  for (const { url, init } of requests) {
    assert.equal(url.origin, 'https://medsculp.buk.pe');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('auth_token'), TOKEN);
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'auth_token']);
    assert.equal(init.redirect, 'manual');
  }
});

test('workforce summary computes the global unique total from validated page-local counts', async (t) => {
  const page2 = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=2`;
  const page3 = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=3`;
  const pages = [
    { data: Array.from({ length: 100 }, (_, index) => employee(index + 1)), pagination: { next: page2, count: 100, total_pages: 3 } },
    { data: Array.from({ length: 100 }, (_, index) => employee(index + 101)), pagination: { next: page3, count: 100, total_pages: 3 } },
    { data: Array.from({ length: 72 }, (_, index) => employee(index + 201)), pagination: { next: null, count: 72, total_pages: 3 } },
  ];
  const { service, requests } = serviceFor(pages.map((page) => json(page)));

  const result = await service.workforceSummary({ as_of: date });
  t.diagnostic(JSON.stringify({ count: result.data.count, complete: result.meta.complete, returned_count: result.meta.returned_count, total_count: result.meta.total_count, warnings: result.warnings }));
  assert.equal(result.data.count, 272);
  assert.equal(result.meta.total_count, 272);
  assert.equal(result.meta.returned_count, 272);
  assert.equal(result.meta.complete, true);
  assert.equal(result.meta.upstream_calls, 3);
  assert.match(result.meta.total_count_semantics, /Computed final unique employee ID total/);
  assert.deepEqual(result.warnings, []);
  assert.equal(requests.length, 3);
  for (const [index, { url, init }] of requests.entries()) {
    assert.equal(url.pathname, '/api/v1/peru/employees/active');
    assert.equal(url.searchParams.get('date'), date);
    assert.equal(url.searchParams.get('exclude_pending'), 'true');
    assert.equal(url.searchParams.get('page_size'), '100');
    assert.equal(url.searchParams.get('page'), index === 0 ? null : String(index + 1));
    assert.equal(init.method, 'GET');
  }

  const duplicatePage = serviceFor([json({ data: [employee(1), employee(1)], pagination: { next: null, count: 1, total_pages: 1 } })]);
  const duplicateResult = await duplicatePage.service.workforceSummary({ as_of: date });
  assert.equal(duplicateResult.data.count, 1);
  assert.equal(duplicateResult.meta.total_count, 1);
  assert.equal(duplicateResult.meta.complete, true);
  assert.deepEqual(duplicateResult.warnings, []);
});

test('workforce summary leaves its global total unknown for missing counts, count mismatches, or incomplete coverage', async () => {
  const missingCount = serviceFor([json({ data: [employee(1)], pagination: { next: null, total_pages: 1 } })]);
  const missingCountResult = await missingCount.service.workforceSummary({ as_of: date });
  assert.equal(missingCountResult.data.count, null);
  assert.equal(missingCountResult.meta.total_count, null);
  assert.equal(missingCountResult.meta.complete, false);
  assert.ok(missingCountResult.warnings.some((warning: string) => warning.includes('Falta pagination.count')));

  const countMismatch = serviceFor([json({ data: [employee(1), employee(2)], pagination: { next: null, count: 1, total_pages: 1 } })]);
  const countMismatchResult = await countMismatch.service.workforceSummary({ as_of: date });
  assert.equal(countMismatchResult.data.count, null);
  assert.equal(countMismatchResult.meta.total_count, null);
  assert.equal(countMismatchResult.meta.returned_count, 2);
  assert.equal(countMismatchResult.meta.complete, false);
  assert.ok(countMismatchResult.warnings.some((warning: string) => warning.includes('IDs únicos')));
  assert.equal(countMismatchResult.warnings.some((warning: string) => warning.includes('snapshot')), false);

  const missingTerminal = serviceFor([json({ data: [employee(1)], pagination: { count: 1, total_pages: 1 } })]);
  const missingTerminalResult = await missingTerminal.service.workforceSummary({ as_of: date });
  assert.equal(missingTerminalResult.data.count, null);
  assert.equal(missingTerminalResult.meta.total_count, null);
  assert.equal(missingTerminalResult.meta.complete, false);
  assert.ok(missingTerminalResult.warnings.some((warning: string) => warning.includes('no confirmó el fin')));

  const page2 = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=2`;
  const changedPages = serviceFor([
    json({ data: [employee(1)], pagination: { next: page2, count: 1, total_pages: 2 } }),
    json({ data: [employee(2)], pagination: { next: null, count: 1, total_pages: 3 } }),
  ]);
  const changedPagesResult = await changedPages.service.workforceSummary({ as_of: date });
  assert.equal(changedPagesResult.data.count, null);
  assert.equal(changedPagesResult.meta.total_count, null);
  assert.equal(changedPagesResult.meta.complete, false);
  assert.ok(changedPagesResult.warnings.some((warning: string) => warning.includes('distintos total_pages')));
  assert.ok(changedPagesResult.warnings.some((warning: string) => warning.includes('no coincide con las páginas recorridas')));
});

test('workforce summary rejects missing or invalid as_of and unknown arguments', async () => {
  const { service, requests } = serviceFor([]);
  await assert.rejects(() => service.workforceSummary({} as never));
  await assert.rejects(() => service.workforceSummary({ as_of: '2026-02-30' }));
  await assert.rejects(() => service.workforceSummary({ as_of: date, company_id: '1' } as never));
  assert.equal(requests.length, 0);
});

test('partial workforce traversal never exposes a final count', async () => {
  const next = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=2`;
  const { service } = serviceFor([
    json({ data: [employee(1)], pagination: { next, count: 1, total_pages: 2 } }),
  ], { maxCalls: 1 });
  const result = await service.workforceSummary({ as_of: date });
  assert.equal(result.data.count, null);
  assert.equal(result.meta.complete, false);
  assert.equal(result.meta.returned_count, 1);
  assert.equal(result.meta.total_count, null);
  assert.ok(result.warnings.some((warning: string) => warning.includes('incomplet')));
});

test('workforce summary fails closed on an unknown envelope and on missing employee IDs', async () => {
  const unknown = serviceFor([json({ employees: [employee(1)] })]);
  await assert.rejects(() => unknown.service.workforceSummary({ as_of: date }), /respuesta|formato|envelope/i);
  const undocumentedArray = serviceFor([json([employee(1)])]);
  await assert.rejects(() => undocumentedArray.service.workforceSummary({ as_of: date }), /respuesta|formato|envelope/i);
  const missingId = serviceFor([json({ data: [{ full_name: 'Synthetic' }], pagination: { next: null, count: 1 } })]);
  const result = await missingId.service.workforceSummary({ as_of: date });
  assert.equal(result.data.count, null);
  assert.equal(result.meta.complete, false);
});

test('native employee search returns candidates without selecting one and excludes document identifiers from output', async () => {
  const { service, requests } = serviceFor([json({ data: [employee(17, { document_number: 'SYNTHETIC-PII', active_since: '2024-01-02' })], pagination: { next: null, count: 1, total_pages: 1 } })]);
  const result = await service.employeesSearch({ status: 'activo', page: 1, page_size: 25 });
  assert.equal(requests[0]?.url.pathname, '/api/v1/peru/employees');
  assert.equal(requests[0]?.url.searchParams.get('status'), 'activo');
  assert.equal(result.data.candidates.length, 1);
  assert.equal(result.data.candidates[0]?.id, '17');
  assert.equal(result.data.candidates[0]?.full_name, 'Synthetic Employee 17');
  assert.equal('selected' in result.data, false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC-PII'), false);
  await assert.rejects(() => service.employeesSearch({ name: 'invented search' } as never));
  await assert.rejects(() => service.employeesSearch({}));
});

test('search output limit includes its truncation warning and final metadata', async (t) => {
  const { service, requests } = serviceFor([json({
    data: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, full_name: `Synthetic Candidate ${index}` })),
    pagination: { next: null, count: 11 },
  })], { maxToolOutputBytes: 2048 });

  const result = await service.employeesSearch({ status: 'activo' });
  const outputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  t.diagnostic(`search output: ${outputBytes} bytes (limit 2048)`);
  assert.ok(outputBytes <= 2048);
  assert.equal(result.meta.complete, false);
  assert.equal(result.meta.returned_count, result.data.candidates.length);
  assert.ok(result.meta.returned_count < 11);
  assert.equal(result.meta.total_count, 11);
  assert.ok(result.warnings.some((warning: string) => warning.includes('tamaño')));
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(result.data.candidates[0] ?? {}).sort(), ['active_since', 'full_name', 'id', 'position', 'status']);
  assert.equal(JSON.stringify(result).includes('document_number'), false);
});

test('search pagination remains explicit and incomplete when upstream announces another page', async () => {
  const next = `${BASE}/employees?status=activo&page=2&page_size=25`;
  const { service } = serviceFor([json({ data: [employee(1)], pagination: { next, count: 2, total_pages: 2 } })]);
  const result = await service.employeesSearch({ status: 'activo' });
  assert.equal(result.meta.complete, false);
  assert.equal(result.meta.returned_count, 1);
  assert.equal(result.meta.total_count, 2);
  assert.ok(result.warnings.some((warning: string) => warning.includes('página')));
});

test('context preserves distinct date sources, projects only documented schedule metadata, and omits sensitive fields', async () => {
  const detail = employee(23, {
    document_number: 'SYNTHETIC-DOCUMENT', email: 'private@example.invalid', phone: '555-0100', bank: 'Synthetic Bank',
    payment_currency: 'PEN', active_since: '2019-04-05', active_until: '2027-02-01',
    current_job: {
      start_date: '2024-03-01', end_date: '2025-03-01', contract_term: '2025-03-10', active_until: '2025-04-01',
      contract_finishing_date_1: '2025-02-01', contract_finishing_date_2: '2025-02-15', weekly_hours: 40,
      days: ['l', 'm'], working_schedule_type: 'turno-diurno', periodicity: 'monthly', frequency: 'weekly',
      base_wage: 2400, role: { id: 6, code: 'ROL-6', name: 'Synthetic Role' }, custom_attributes: { private: 'omit' },
    },
  });
  const { service } = serviceFor([
    json(detail),
    json({ data: [{ start_date: '2023-01-01', end_date: '2024-02-28', end_of_contract: '2024-02-29', regular_hours: '40h', role: { name: 'Old Role' }, currency_code: 'PEN' }], pagination: { next: null, count: 1 } }),
  ]);
  const result = await service.employeeContext({ employee_id: '23', include_salary: false });
  assert.equal(result.data.employee.id, '23');
  assert.equal(result.data.employee.full_name, 'Synthetic Employee 23');
  assert.deepEqual(result.data.employee.dates.active_since, { value: '2019-04-05', source_field: 'active_since' });
  assert.deepEqual(result.data.employee.dates.employee_active_until, { value: '2027-02-01', source_field: 'active_until' });
  assert.deepEqual(result.data.employee.dates.start_date, { value: '2024-03-01', source_field: 'current_job.start_date' });
  assert.deepEqual(result.data.employee.dates.end_date, { value: '2025-03-01', source_field: 'current_job.end_date' });
  assert.deepEqual(result.data.employee.dates.contract_term, { value: '2025-03-10', source_field: 'current_job.contract_term' });
  assert.deepEqual(result.data.employee.dates.current_job_active_until, { value: '2025-04-01', source_field: 'current_job.active_until' });
  assert.deepEqual(result.data.employee.dates.contract_finishing_date_1, { value: '2025-02-01', source_field: 'current_job.contract_finishing_date_1' });
  assert.deepEqual(result.data.employee.dates.contract_finishing_date_2, { value: '2025-02-15', source_field: 'current_job.contract_finishing_date_2' });
  assert.deepEqual(result.data.employee.position, { id: '6', code: 'ROL-6', name: 'Synthetic Role' });
  assert.equal(result.data.employee.schedule.daily_times_available, false);
  assert.equal(result.data.employee.schedule.daily_start_time, null);
  assert.equal(result.data.employee.schedule.daily_end_time, null);
  assert.equal(result.data.employee.schedule.weekly_hours.value, 40);
  assert.equal(result.data.employee.salary, null);
  assert.equal(result.data.jobs[0]?.dates.end_of_contract.value, '2024-02-29');
  const serialized = JSON.stringify(result);
  for (const sensitive of ['SYNTHETIC-DOCUMENT', 'private@example.invalid', '555-0100', 'Synthetic Bank', 'custom_attributes', 'private']) {
    assert.equal(serialized.includes(sensitive), false);
  }
  assert.ok(result.warnings.some((warning: string) => warning.includes('diarios')));
});

test('salary is included by default and can still be explicitly omitted', async () => {
  const included = serviceFor([json(employee(7, { current_job: { base_wage: 2400 } }))]);
  const result = await included.service.employeeContext({ employee_id: '7', include_jobs: false });
  assert.equal(result.data.salary_included, true);
  assert.equal(result.data.employee.salary?.amount, 2400);
  assert.equal(included.requests.length, 1);
  assert.equal(included.requests[0]?.init.method, 'GET');
  const omitted = serviceFor([json(employee(7, { current_job: { base_wage: 2400 } }))]);
  const privateResult = await omitted.service.employeeContext({ employee_id: '7', include_jobs: false, include_salary: false });
  assert.equal(privateResult.data.salary_included, false);
  assert.equal(privateResult.data.employee.salary, null);
  assert.equal(JSON.stringify(privateResult).includes('2400'), false);
  assert.equal(omitted.requests.length, 1);
});

test('salary preserves zero and absent amount stays null without inferring currency', async () => {
  const allowed = serviceFor([json(employee(8, { payment_currency: 'PEN', current_job: { base_wage: 0 } }))]);
  const zero = await allowed.service.employeeContext({ employee_id: '8', include_jobs: false, include_salary: true });
  assert.deepEqual(zero.data.employee.salary, { amount: 0, currency: null, source_field: 'current_job.base_wage', currency_source_field: null });

  const absent = serviceFor([json(employee(9, { payment_currency: 'PEN', current_job: {} }))]);
  const noAmount = await absent.service.employeeContext({ employee_id: '9', include_jobs: false, include_salary: true });
  assert.equal(noAmount.data.employee.salary?.amount, null);
  assert.equal(noAmount.data.employee.salary?.currency, null);
});

test('context keeps the employee detail but marks jobs incomplete when its call budget is exhausted', async () => {
  const { service, requests } = serviceFor([json(employee(30))], { maxCalls: 1 });
  const result = await service.employeeContext({ employee_id: '30' });
  assert.equal(requests.length, 1);
  assert.equal(result.data.employee.id, '30');
  assert.deepEqual(result.data.jobs, []);
  assert.equal(result.jobs_meta.complete, false);
  assert.equal(result.jobs_meta.total_count, null);
  assert.equal(result.meta.complete, false);
  assert.ok(result.warnings.some((warning: string) => warning.includes('presupuesto')));
});

test('context accepts the confirmed data-object employee detail envelope', async () => {
  const { service, requests } = serviceFor([json({ data: employee(23, { active_since: '2022-04-01', current_job: { base_wage: 2400 } }) })]);
  const result = await service.employeeContext({ employee_id: '23', include_jobs: false });
  assert.equal(result.data.employee.id, '23');
  assert.equal(result.data.employee.dates.active_since.value, '2022-04-01');
  assert.equal(result.data.employee.salary?.amount, 2400);
  assert.equal(result.data.salary_included, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.init.method, 'GET');
});

test('context accepts only canonical numeric employee IDs and fails closed on unknown detail/jobs envelopes', async () => {
  const { service, requests } = serviceFor([]);
  for (const employee_id of ['../23', '23%2fjobs', 'https://attacker.invalid/23', ' 23']) {
    await assert.rejects(() => service.employeeContext({ employee_id }));
  }
  assert.equal(requests.length, 0);
  for (const detail of [{ data: [employee(23)] }, { data: null }, { data: employee(24) }, employee(24), { data: employee(23), id: 23 }, { data: { data: employee(23) } }]) {
    const unknownDetail = serviceFor([json(detail)]);
    await assert.rejects(() => unknownDetail.service.employeeContext({ employee_id: '23', include_jobs: false }), /respuesta|formato|envelope/i);
    assert.equal(unknownDetail.requests.length, 1);
  }
  const unknownJobs = serviceFor([json(employee(23)), json({ jobs: [] })]);
  await assert.rejects(() => unknownJobs.service.employeeContext({ employee_id: '23' }), /respuesta|formato|envelope/i);
});

test('unsafe pagination links are rejected without making a second request', async () => {
  const unsafe = [
    'https://attacker.invalid/api/v1/peru/employees/active?page=2',
    `${BASE}/employees?page=2`,
    `${BASE}/employees/active?date=2025-01-01&exclude_pending=true&page=2`,
    `${BASE}/employees/active%2fjobs?date=${date}&exclude_pending=true&page=2`,
    `${BASE}/employees/active?date=${date}&exclude_pending=true&page=2&next=https%3A%2F%2Fevil.invalid`,
    `${BASE}/employees/active?date=${date}&exclude_pending=true&page=2`,
  ];
  for (const next of unsafe) {
    const { service, requests } = serviceFor([json({ data: [employee(1)], pagination: { next, count: 1 } })]);
    await assert.rejects(() => service.workforceSummary({ as_of: date }));
    assert.equal(requests.length, 1);
  }
});

test('redirects and non-retryable HTTP errors fail closed without leaking response bodies or token', async () => {
  for (const status of [301, 400, 401, 403, 404]) {
    let attempts = 0;
    const client = new BukHttpClient({
      authToken: TOKEN,
      fetcher: async () => { attempts += 1; return new Response(`body-secret ${TOKEN}`, { status }); },
    });
    await assert.rejects(() => client.get('/employees/active', { date, exclude_pending: true }));
    assert.equal(attempts, 1);
  }
  const client = new BukHttpClient({
    authToken: TOKEN,
    fetcher: async () => new Response(`body-secret ${TOKEN}`, { status: 403 }),
  });
  await assert.rejects(() => client.get('/employees/active', { date, exclude_pending: true }), (error: unknown) => {
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(String(error).includes('body-secret'), false);
    return true;
  });
});

test('429 and 5xx retries are bounded; response bodies and headers never become errors', async () => {
  let attempts = 0;
  const client = new BukHttpClient({
    authToken: TOKEN,
    maxRetries: 2,
    fetcher: async () => {
      attempts += 1;
      return attempts < 3
        ? new Response(`secret ${TOKEN}`, { status: 503, headers: { 'retry-after': '0' } })
        : json({ data: [] });
    },
  });
  const result = await client.get('/employees/active', { date, exclude_pending: true });
  assert.deepEqual(result, { data: [] });
  assert.equal(attempts, 3);

  attempts = 0;
  const exhausted = new BukHttpClient({ authToken: TOKEN, maxRetries: 1, fetcher: async () => { attempts += 1; return new Response(TOKEN, { status: 429, headers: { 'retry-after': '999999' } }); } });
  await assert.rejects(() => exhausted.get('/employees/active', { date, exclude_pending: true }), (error: unknown) => {
    assert.equal(String(error).includes(TOKEN), false);
    return true;
  });
  assert.equal(attempts, 2);
});

test('request timeout and cancellation are bounded and sanitized', async () => {
  const timeoutClient = new BukHttpClient({
    authToken: TOKEN,
    timeoutMs: 10,
    maxRetries: 0,
    fetcher: (_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('synthetic transport failure')), { once: true });
    }),
  });
  await assert.rejects(() => timeoutClient.get('/employees/active', { date, exclude_pending: true }), /timeout|red|BUK/i);
  const bodyTimeout = new BukHttpClient({
    authToken: TOKEN,
    timeoutMs: 10,
    maxRetries: 0,
    fetcher: async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const bodyOutcome = await Promise.race([
    bodyTimeout.get('/employees/active', { date, exclude_pending: true }).then(() => 'resolved', () => 'rejected'),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
  assert.equal(bodyOutcome, 'rejected');
  const controller = new AbortController();
  controller.abort();
  const cancelled = new BukHttpClient({ authToken: TOKEN, fetcher: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => cancelled.get('/employees/active', { date, exclude_pending: true }, { signal: controller.signal }));
});

test('client rejects arbitrary paths, query keys, insecure or different origins, and oversized JSON', async () => {
  let calls = 0;
  const client = new BukHttpClient({ authToken: TOKEN, fetcher: async () => { calls += 1; return json({}); } });
  for (const path of ['/other', '/employees/%2e%2e/jobs', 'https://attacker.invalid/employees/active', '/employees/1/jobs/extra']) {
    await assert.rejects(() => client.get(path, {} as never));
  }
  await assert.rejects(() => client.get('/employees/active', { next: 'https://attacker.invalid' } as never));
  assert.equal(calls, 0);

  assert.throws(() => new BukHttpClient({ authToken: TOKEN, baseUrl: 'http://medsculp.buk.pe/api/v1/peru', fetcher: async () => json({}) }));
  const oversized = new BukHttpClient({ authToken: TOKEN, maxResponseBytes: 32, fetcher: async () => json({ data: 'x'.repeat(500) }) });
  await assert.rejects(() => oversized.get('/employees/active', { date, exclude_pending: true }), /tamaño|size|large|límite/i);
});

test('repeated pagination links and record ceilings return incomplete counts instead of looping or finalizing', async () => {
  const repeated = `${BASE}/employees/active?date=${date}&exclude_pending=true&page_size=100&page=2`;
  const loop = serviceFor([
    json({ data: [employee(1)], pagination: { next: repeated, count: 1 } }),
    json({ data: [employee(2)], pagination: { next: repeated, count: 1 } }),
  ]);
  const loopResult = await loop.service.workforceSummary({ as_of: date });
  assert.equal(loop.requests.length, 2);
  assert.equal(loopResult.data.count, null);
  assert.equal(loopResult.meta.complete, false);
  assert.ok(loopResult.warnings.some((warning: string) => warning.includes('ciclo')));

  const bounded = serviceFor([json({ data: [employee(1), employee(2)], pagination: { next: null, count: 2 } })], { maxRecords: 1 });
  const boundedResult = await bounded.service.workforceSummary({ as_of: date });
  assert.equal(boundedResult.data.count, null);
  assert.equal(boundedResult.meta.returned_count, 1);
  assert.ok(boundedResult.warnings.some((warning: string) => warning.includes('límite')));
});

test('network retries are bounded and output size truncation is explicitly incomplete', async (t) => {
  let attempts = 0;
  const retryClient = new BukHttpClient({
    authToken: TOKEN,
    maxRetries: 1,
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(`transport exposed ${TOKEN}`);
      return json({ data: [] });
    },
  });
  assert.deepEqual(await retryClient.get('/employees/active', { date, exclude_pending: true }), { data: [] });
  assert.equal(attempts, 2);

  attempts = 0;
  const bodyRetry = new BukHttpClient({
    authToken: TOKEN,
    maxRetries: 1,
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('synthetic body network error')); } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return json({ data: [] });
    },
  });
  assert.deepEqual(await bodyRetry.get('/employees/active', { date, exclude_pending: true }), { data: [] });
  assert.equal(attempts, 2);

  const jobs = Array.from({ length: 60 }, (_, index) => ({
    start_date: `202${Math.floor(index / 10)}-01-${String(index % 28 + 1).padStart(2, '0')}`,
    end_date: null,
    end_of_contract: null,
    regular_hours: `${index} hours`,
    role: { name: `Synthetic role ${index}` },
    currency_code: 'SYNTHETIC-CURRENCY',
    custom_attributes: { private: 'SYNTHETIC-RAW' },
  }));
  const large = serviceFor([
    json(employee(8, { document_number: 'SYNTHETIC-CONTEXT-PII' })),
    json({ data: jobs, pagination: { next: null, count: jobs.length } }),
  ], { maxToolOutputBytes: 2048 });
  const result = await large.service.employeeContext({ employee_id: '8', include_salary: false });
  const outputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  t.diagnostic(`context jobs output: ${outputBytes} bytes (limit 2048)`);
  assert.ok(outputBytes <= 2048);
  assert.equal(large.requests.length, 2);
  assert.equal(result.meta.complete, false);
  assert.equal(result.jobs_meta.complete, false);
  assert.equal(result.jobs_meta.returned_count, result.data.jobs.length);
  assert.ok(result.jobs_meta.returned_count < jobs.length);
  assert.ok(result.warnings.some((warning: string) => warning.includes('tamaño')));
  const serialized = JSON.stringify(result);
  for (const excluded of ['SYNTHETIC-CURRENCY', 'SYNTHETIC-RAW', 'SYNTHETIC-CONTEXT-PII']) assert.equal(serialized.includes(excluded), false);
  const withSalary = serviceFor([
    json(employee(8, { document_number: 'SYNTHETIC-CONTEXT-PII' })),
    json({ data: jobs, pagination: { next: null, count: jobs.length } }),
  ], { maxToolOutputBytes: 2048 });
  await assert.rejects(() => withSalary.service.employeeContext({ employee_id: '8' }), (error: unknown) => {
    assert.match(String(error), /output exceeded the size limit/);
    assert.equal(String(error).includes('SYNTHETIC-CONTEXT-PII'), false);
    return true;
  });
});
