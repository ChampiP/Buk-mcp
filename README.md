# buk-mcp-server

Read-only MCP server for the BUK Peru API over stdio. It uses `@modelcontextprotocol/server` 2.4.0 and exposes only registered BUK GET operations.

## Tools

There are 22 tools: 3 phase-one tools and 19 domain tools. The table shows registry-assigned operations / operations exposed in tool schemas. The registry has 119 operations; one PDF route is filtered out, leaving 118 exposed. `Sensitive` mirrors the generated domain flag.

| Tool | Operations (registry / exposed) | Sensitive |
|---|---:|:---:|
| `buk_workforce_summary` | 1 / 1 | No |
| `buk_employees_search` | 1 / 1 | No |
| `buk_employee_context` | 2 / 2 | No |
| `buk_absences` | 16 / 16 | No |
| `buk_accounting` | 11 / 11 | No |
| `buk_organization` | 12 / 12 | No |
| `buk_attendance` | 8 / 8 | No |
| `buk_benefits` | 3 / 3 | No |
| `buk_company_data` | 6 / 6 | No |
| `buk_compensation` | 5 / 5 | Yes |
| `buk_documents` | 3 / 3 | Yes |
| `buk_employee_sections` | 6 / 6 | Yes |
| `buk_payroll_detail` | 5 / 4 | Yes |
| `buk_vacations` | 8 / 8 | No |
| `buk_org_catalogs` | 6 / 6 | No |
| `buk_job_termination` | 1 / 1 | Yes |
| `buk_job_events` | 3 / 3 | No |
| `buk_users_permissions` | 3 / 3 | Yes |
| `buk_piecework` | 6 / 6 | No |
| `buk_payroll_processes` | 3 / 3 | No |
| `buk_recruiting` | 5 / 5 | Yes |
| `buk_talent_training` | 5 / 5 | No |

The three phase-one tool names, input/output schemas, and annotations remain unchanged.

## Domain tool input

Domain tools use a strict request wrapper (the three phase-one tools keep their original flat arguments). This example is for `buk_org_catalogs`; each `operation` selects one operation and its validated parameters:

```json
{
  "request": {
    "operation": "roles",
    "search": "analista",
    "page_size": 25,
    "all_pages": true
  }
}
```

Operation names are lowercase path names with separators replaced by underscores and `{parameter}` replaced by `by_parameter`; for example, `/roles/{id}` becomes `roles_by_id`. Unknown fields and unsupported operations are rejected.

Array query parameters are exposed only when the registry specifies `collectionFormat: multi` and integer items. The four `employees_id` array parameters whose Swagger definitions omit this encoding information are not exposed until their wire format is verified.

`/employees/{id}/statements/{year}-{month}.pdf` is in the registry but not exposed as a tool operation: the HTTP client accepts JSON responses only. File endpoints that respond with redirects return an error because redirects are refused.

## Results and pagination

A successful domain call returns `operation`, `data`, `meta`, and `warnings`. `meta` includes `complete`, `returned_count`, `total_count`, `total_count_semantics`, and `upstream_calls`, as well as `source` and `fetched_at`.

Calls return one page by default. If BUK reports another page and `all_pages` is not set, the result is marked incomplete. `all_pages` is offered on registry-marked paginated operations and operations without path parameters (including `/users`, whose Swagger omits pagination metadata); setting it to `true` follows pagination links for list responses. Traversal stops if a link repeats or the call, time, or record budget is reached. Output is also capped by size. When a full traversal completes, `total_count` is the number of records returned; otherwise it reflects BUK's count when provided, which may be page-local.

Default per-tool limits are 50 upstream calls, 5,000 records, 60 seconds, and 100,000 output bytes. HTTP calls have a 15-second timeout, at most 2 retries, and a 1 MiB response limit; configuration ranges are listed below.

## Safety

- Requests use `GET` only, against registered routes on `https://medsculp.buk.pe/api/v1/peru`; query parameters are validated against each route and no request body is sent.
- Redirects are refused. Pagination links are checked against the approved origin, route, and original filters before another request is made.
- `BUK_AUTH_TOKEN` is supplied by the MCP host, sent in the `auth_token` header, and is not a tool argument or included in logs or errors. As defense in depth, the client also redacts its own token from every tool result in case an upstream body echoes it.
- Pagination links are parsed into a null-prototype record, so keys such as `__proto__` are validated like any other and rejected.
- The client accepts JSON responses only. File-download endpoints that redirect therefore return an error.
- The MCP transport uses stdout; startup diagnostics are written to stderr.

## Configuration

Only process environment variables are read; the server does not load `.env` files. Set `BUK_AUTH_TOKEN` in the MCP host environment.

| Variable | Default | Accepted value |
|---|---|---|
| `BUK_AUTH_TOKEN` | Required | Non-empty; no leading/trailing whitespace or CR, LF, or NUL |
| `BUK_BASE_URL` | `https://medsculp.buk.pe/api/v1/peru` | Any non-empty value must equal this URL |
| `BUK_HTTP_TIMEOUT_MS` | `15000` | 1–15000 |
| `BUK_MAX_RETRIES` | `2` | 0–2 |
| `BUK_TOOL_MAX_CALLS` | `50` | 1–50 |
| `BUK_TOOL_MAX_RECORDS` | `5000` | 1–5000 |
| `BUK_TOOL_TIMEOUT_MS` | `60000` | 1–60000 |
| `BUK_MAX_RESPONSE_BYTES` | `1048576` | 1024–1048576 |
| `BUK_MAX_TOOL_OUTPUT_BYTES` | `100000` | 2048–100000 |

Numeric values are integers in the listed ranges. The base URL cannot be changed to another origin or path.

## Registry and specs

| File | Contents |
|---|---|
| `spec/buk-peru-get.registry.json` | Snapshot of BUK Peru Swagger GET operations, including parameter and response-schema metadata. |
| `spec/domains.json` | Operation-to-tool grouping and generated sensitive labels. |
| `spec/phase-one-snapshot.json` | Phase-one routes and projection details. |

The current registry has 119 GET operations: 3 deprecated operations, 10 without a Swagger 200 response schema, 8 path parameters not marked required, and one unresolved schema reference (`CuentaContable`). Operations without a response schema are reported as such; no response shape is invented.

Regenerate the registry from a local Swagger JSON file (or a URL):

```sh
node scripts/extract-registry.mjs path/to/swagger.json
```

This writes `spec/buk-peru-get.registry.json` and `src/operations.generated.ts`. The extractor uses BUK's Swagger URL if no input is supplied. Rebuild the domain grouping and generated tool registry with:

```sh
node scripts/build-domains.mjs
```

This writes `spec/domains.json` and `src/domains.generated.ts`.

## Known limits

- In the tested tenant, `/accounting` answers in about 26 to 39 seconds with roughly 110 KB and ignores `page_size`. It is the only operation with a longer attempt timeout (55 seconds, no retries); the 100,000-byte output cap truncates its result and marks it incomplete. Other accounting exports were not measured and keep the 15-second timeout. BUK requires `month` and `year` for `/accounting` and `empresa_id` for `/accounting_structure/assignments` although its Swagger does not mark them required; the schemas require them.
- HTTP 404 responses are errors, not empty results; domain tools explain 400, 401, 403, 404, timeouts and refused redirects in the error text. Observed examples: `/accounting/export*` returned 404 for period 9/2026; `/training/sence_percents/{employee_id}` returned 404 when that employee had no record.
- The tested tenant had no sample data for evaluations, applicants, credits, unions, benefits, or company-variable registries. Their by-ID operations are covered by unit tests only, not validated against real records.
- Listing all 22 tools costs about 23,000 tokens in the measured tool list.

## Requirements

Node.js >= 22. The test suite has passed on Node 22.23, 24.22, and 26.7.

## Install

Run it straight from GitHub; `npm` clones the repository, installs dependencies and compiles it (`prepare` script) on first use:

```sh
claude mcp add buk --env BUK_AUTH_TOKEN=your_token -- npx -y github:ChampiP/Buk-mcp
```

Any MCP host works with the same stdio entry: `command: npx`, `args: ["-y", "github:ChampiP/Buk-mcp"]`, `env: { BUK_AUTH_TOKEN: ... }`. The token belongs in the host's environment, never in the repository.

Measured start-up: about 34 seconds on a cold cache (first run) and about 10 seconds afterwards, which can exceed a host's start-up timeout on the first run. Either run the command once by hand to warm the cache, raise the host's MCP start-up timeout, or install once and call the binary directly:

```sh
npm install -g github:ChampiP/Buk-mcp   # then use the command: buk-mcp-server
```

Pin a commit or tag (`github:ChampiP/Buk-mcp#<ref>`) so the server does not change under you.

To run a local checkout instead:

```sh
npm ci && npm test && npm run build
claude mcp add buk --env BUK_AUTH_TOKEN=your_token -- node /path/to/Buk-mcp/dist/src/main.js
```

A tarball (`npm pack`, then `npm install ./buk-mcp-server-1.0.0.tgz`) also works and exposes `node_modules/.bin/buk-mcp-server`.

## Test

`npm test` builds the project and runs `test-runner.cjs`:

```sh
npm test
```
