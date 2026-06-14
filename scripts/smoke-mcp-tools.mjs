#!/usr/bin/env node
/**
 * Boots MCP server over stdio and asserts initialize + tools/list succeed.
 * Used by mcp-scorecard smoke signal and local CI checks.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function send(proc, msg) {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

const child = spawn('pnpm', ['exec', 'tsx', 'apps/mcp-server/src/index.ts'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, MCP_PROBE: '1' }
});

const rl = createInterface({ input: child.stdout });
let toolsCount = 0;
let failed = false;

const timeout = setTimeout(() => {
  console.error('smoke-mcp-tools: timeout');
  failed = true;
  child.kill();
}, 15_000);

rl.on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1 && msg.result) {
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  }
  if (msg.id === 2) {
    toolsCount = msg.result?.tools?.length ?? 0;
    clearTimeout(timeout);
    child.kill();
  }
  if (msg.error) {
    failed = true;
    console.error('smoke-mcp-tools RPC error:', msg.error);
    clearTimeout(timeout);
    child.kill();
  }
});

send(child, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0' }
  }
});

child.on('exit', () => {
  if (failed || toolsCount < 5) {
    console.error(`smoke-mcp-tools: failed (tools=${toolsCount})`);
    process.exit(1);
  }
  console.log(`smoke-mcp-tools: ok (${toolsCount} tools)`);
  process.exit(0);
});
