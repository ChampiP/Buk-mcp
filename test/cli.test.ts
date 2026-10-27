import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
    const result = spawnSync(process.execPath, [shim], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /BUK_AUTH_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
