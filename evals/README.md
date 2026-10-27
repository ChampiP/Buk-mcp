# BUK MCP evaluations

This directory contains ten read-only Spanish HR questions and executable MCP recipes. The runner prints aggregate answers and verification metrics only; tenant-specific ground truth is written only to the git-ignored `evals/private/buk-tenant.xml`. Do not share or commit that XML.

## Run

```sh
npm run build && node --env-file=.env evals/run.mjs
```

The runner launches `dist/src/main.js` over stdio and passes the child only `PATH` and `BUK_AUTH_TOKEN`.

## Use the XML

The MCP-builder `scripts/evaluation.py` takes the XML as its positional `eval_file`; for a local server, its argparse options include `-t stdio -c node -a dist/src/main.js` and `-e KEY=VALUE` for child environment variables. The harness additionally needs an `ANTHROPIC_API_KEY` and its Python dependencies. This project does not run that harness automatically.
