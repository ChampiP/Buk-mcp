# BUK GET coverage (phase 2)
Extend buk-mcp-server from 3 tools to all 119 BUK Peru GET operations, read-only. Granularity decided by the user: option A (about 20 domain tools).
Phase-one tools are already validated against real BUK (workforce count matched an independent traversal: 272).

## Specs
- S1: "vamos a ir por las siguiente que seria todos ya" — cover every GET operation of the BUK Peru Swagger.
- S2: "solo lectura consulta" / "nada de editar eliminar o crear" — only GET to BUK; no POST, PUT, PATCH, DELETE ever.
- S3: Granularity = option A: "~20 tools por dominio" — one tool per domain with a closed `operation` selector and per-operation validated parameters; sensitive domains (payroll, salary, documents, users) in their own tools. Domain list is derived from the Swagger registry in T1, not guessed.
- S4: "no quiero que te inventes arquitectura procesos etc" — follow the official SDK v2 docs and the mcp-builder skill; the markdown consolidated document is NOT a source of truth ("puede mentir en algunas cosas").
- S5: "sea escalable de calidad rapido" — registry-driven design so adding an operation is data, not new code paths.
- S6: Phase-one tool names, inputs and outputs stay unchanged (`buk_workforce_summary`, `buk_employees_search`, `buk_employee_context`).
- S7: Existing guards stay: exact origin https://medsculp.buk.pe, base /api/v1/peru, registered routes only, no redirects, validated pagination links, token never in args/logs/errors.
- S8: No HTTP-generic tool and no bag of free optionals; request only what was asked; explicit budgets, errors and `complete` flag. Responses without a Swagger 200 schema (10 GETs) are reported as such, never invented.
- S9: Real-data validation is read-only, reports aggregates only, and real employee data is never committed.

## Tasks
- T1 (S1,S3,S5,S8) route: inline. Extract the 119 GET operations from the live Swagger into a committed snapshot + registry types; derive the domain grouping from Swagger tags; list defects. Commit: see git log "feat(spec): add BUK GET registry".
- T2 (S2,S5,S7) route: inline. Generalize the HTTP client to registry-driven GET (path param encoding, query allowlist per operation, per-endpoint pagination), keeping every phase-one guard. Commit: see git log "feat(client): registry-driven GET policy".
- T3 (S3,S5,S8) route: inline. Domain tool framework: discriminated-union input per tool from the registry, normalized envelope, budgets, `complete`, actionable errors. Commit: see git log "feat(tools): domain tools generated from the registry".
- T4 (S1,S3) route: inline. Re-scoped: the 19 domain tools are generated from the registry in T3; T4 is now per-domain quality (descriptions, sensitive labelling, PDF decision, arrays encoding) driven by T6 findings. Commit: pending.
- T5 (S6) route: inline. Regression: phase-one contracts byte-identical against the previous build. Commit: pending.
- T6 (S9) route: inline. Real read-only validation per domain (aggregates only), fixtures anonymized. Commit: pending.
- T7 route: inline. README, version, packaged install test, evaluations. Commit: pending.

## Log
- L1: "ya lo puse en .env revisa" → "si luiego le dire que lo roten pero primero validemos todo y luego validando estas 3 tools que funcionen ok vamos a ir por las siguiente que seria todos ya"
- L2: user chose option A (~20 domain tools).
- L3: "el documento que tienes el markdown es uno que no revise la arquitectura ni puiede ser la mejor puede mentir en algunas coas asi que no te confies"
- L4: T1 evidence: registry has 119 GET, 3 deprecated (/absences, /areas, /areas/{id}), 10 without a 200 schema, 8 path params without `required`, 1 unresolved ref (CuentaContable). Grouping gives 22 tools = 3 phase-one + 19 new, 6 of them sensitive (job_termination, payroll_detail, compensation, documents, users_permissions, recruiting).
- L5: T2 evidence: 39/39 tests. Differential vs f4fe4ba client over 22 phase-one inputs: 21 identical, 1 intended difference (/users now registered). Finding: `employees_id` array params (4 ops: /employees/absences/*, /employees/overtimes) publish no collectionFormat or item type in the Swagger; they are denied until the encoding is verified read-only against real BUK in T6. `/employees/{id}/statements/{year}-{month}.pdf` is routable but the client only reads JSON, so PDF handling is still open (T3/T4 decision).
- L6: T3 decisions: (a) input is `{ request: <oneOf operations> }`; a root-level oneOf is valid for the SDK (it emits type:object) but host support is unverified, the wrapper is safe everywhere; (b) outputSchema is lean (`operation`, `data`, `meta.complete`, `warnings`) because it repeats in every tool; (c) `/employees/{id}/statements/{year}-{month}.pdf` is NOT exposed (client reads JSON only); (d) `employees_id` array params (4 ops) are NOT in the schemas until the wire encoding is verified; (e) buk_employee_sections marked sensitive (family and person data). Cost measured: tool list ~82k chars (about 23k tokens) for 22 tools, down from 114k after trimming descriptions, bounds and output schemas. Open option: an env allowlist of exposed tools if the context cost matters in a host without deferred tool loading.
- L7: T5 evidence: against a clean build of f4fe4ba, the three phase-one tool definitions (name, title, description, input/output schema, annotations) are byte-identical, and 10 real read-only calls (valid and invalid inputs) return identical structuredContent ignoring fetched_at.
