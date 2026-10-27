import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const mainEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');

test('entry point starts when launched through a symlink such as the npm bin shim, and reports a missing token on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buk-mcp-bin-'));
  try {
    const shim = join(dir, 'buk-mcp-server');
    symlinkSync(mainEntry, shim);
    const result = spawnSync(process.execPath, [shim], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, cwd: dir, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /BUK_AUTH_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n';

function launch(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [mainEntry], { encoding: 'utf8', input: initialize, cwd: dir, env: { PATH: process.env.PATH ?? '', ...env }, timeout: 5000 });
}

test('entry point reads BUK_AUTH_TOKEN from the .env file of the launch directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buk-mcp-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'BUK_AUTH_TOKEN=token-from-dotenv\n');
    const result = launch(dir);
    assert.match(result.stdout, /"serverInfo"/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a BUK_AUTH_TOKEN already set in the environment wins over the .env file, and a .env without a token still reports it missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buk-mcp-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'BUK_AUTH_TOKEN=\n');
    const missing = launch(dir);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /BUK_AUTH_TOKEN/);
    const preset = launch(dir, { BUK_AUTH_TOKEN: 'from-host' });
    assert.match(preset.stdout, /"serverInfo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
