# buk-mcp-server

Read-only [MCP](https://modelcontextprotocol.io) server for the BUK Peru API, served over stdio.
Built on the official TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0).

Phase one: three tools extracted from Depiloto, contracts unchanged. Coverage of the remaining BUK GET operations is out of scope until driven by evaluations.

## Tools

| Tool | BUK GET | Purpose |
|---|---|---|
| `buk_workforce_summary` | `/employees/active` | Count employee records active on `as_of` (`YYYY-MM-DD`). Walks and deduplicates pages by `id`; the count is records, not unique people. |
| `buk_employees_search` | `/employees` | Candidates by the native BUK filters only (no name search). Never picks a person automatically. |
| `buk_employee_context` | `/employees/{id}`, `/employees/{id}/jobs` | Record and optional job history for an exact numeric employee ID. Salary is included by default; `include_salary: false` omits it. |

All tools are annotated `readOnlyHint: true` and return `structuredContent` that matches their `outputSchema`.
Failures are `isError: true` results with a sanitized message. Incomplete results (page or call budget exhausted) say so with `meta.complete: false`.

Known limits of the data, not of the server: BUK does not publish daily entry/exit times, `payment_currency` is not a salary currency, and `pagination.count` is page-local until a full traversal finishes.

## Requirements

Node.js >= 22. The suite (29 tests) passes on Node 22.23, 24.22 and 26.7.

## Install

The package is not published. Build a tarball and install it where the host runs it:

```sh
npm ci && npm test      # builds and runs the suite
npm pack                # creates buk-mcp-server-1.0.0.tgz
npm install /path/to/buk-mcp-server-1.0.0.tgz
```

The binary is `node_modules/.bin/buk-mcp-server`. Pin the version; do not fetch `latest` at startup.

## Configure

Only process environment variables are read. There is no `.env` loading: the MCP host injects them.

| Variable | Default | Range |
|---|---|---|
| `BUK_AUTH_TOKEN` | required | BUK API key with read permissions |
| `BUK_BASE_URL` | `https://medsculp.buk.pe/api/v1/peru` | must equal the default, any other value is rejected |
| `BUK_HTTP_TIMEOUT_MS` | 15000 | 1 to 15000 |
| `BUK_MAX_RETRIES` | 2 | 0 to 2 |
| `BUK_TOOL_MAX_CALLS` | 50 | 1 to 50 |
| `BUK_TOOL_MAX_RECORDS` | 5000 | 1 to 5000 |
| `BUK_TOOL_TIMEOUT_MS` | 60000 | 1 to 60000 |
| `BUK_MAX_RESPONSE_BYTES` | 1048576 | 1024 to 1048576 |
| `BUK_MAX_TOOL_OUTPUT_BYTES` | 100000 | 2048 to 100000 |

The limits are server-chosen ceilings, not BUK-published quotas. Never commit a real token; `.env.example` is intentionally empty.

Register it in a host, for example Claude Code:

```sh
claude mcp add buk --env BUK_AUTH_TOKEN=... -- /path/to/node_modules/.bin/buk-mcp-server
```

or any stdio entry (`command` plus `env`) in the host's MCP config.

## Safety guarantees

- Only registered GET routes, only on `https://medsculp.buk.pe`, base `/api/v1/peru`; query keys are validated and no body is sent.
- Redirects are not followed and pagination links are validated against the same origin before any request carries the token.
- The token is never accepted as a tool argument, logged, or included in errors.
- stdout is reserved for the protocol; diagnostics go to stderr.

## Architecture

```text
src/
  config.ts    environment -> validated BukConfig
  client.ts    GET-only HTTP client, origin guard, retries, size limits
  service.ts   composition, pagination, projections, budgets
  schemas.ts   Zod input and output schemas
  server.ts    MCP tool registration (adapter)
  main.ts      stdio entry point (the npm bin)
```

Dependency direction: `server -> service -> client`; configuration is injected from `main.ts`.
`spec/phase-one-snapshot.json` records the BUK routes and fields the three tools rely on.

## Development

```sh
npm run typecheck
npm test            # build, then node --test over dist/test
npx @modelcontextprotocol/inspector node dist/src/main.js   # needs BUK_AUTH_TOKEN
```

Tests use synthetic responses; they do not verify tenant permissions or live BUK payloads.
