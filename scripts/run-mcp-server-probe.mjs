#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  'pnpm',
  ['exec', 'tsx', 'apps/mcp-server/src/index.ts'],
  { cwd: root, stdio: 'inherit', env: process.env }
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
