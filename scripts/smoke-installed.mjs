// Starts the globally installed `buk-mcp-server` through the shell (the npm .cmd shim on Windows)
// from a directory whose only token source is a .env file, and expects an MCP initialize reply.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'buk-smoke-'));
writeFileSync(join(dir, '.env'), 'BUK_AUTH_TOKEN=smoke-token\n');
const env = { ...process.env };
delete env.BUK_AUTH_TOKEN;

const child = spawn('buk-mcp-server', { cwd: dir, env, shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => { console.error('smoke: timed out'); child.kill(); process.exit(1); }, 15000);
let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk;
  if (out.includes('"serverInfo"')) { clearTimeout(timer); console.log('smoke: ok'); child.kill(); process.exit(0); }
});
child.on('exit', (code) => { clearTimeout(timer); console.error(`smoke: server exited early (${code})`); process.exit(1); });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n');
