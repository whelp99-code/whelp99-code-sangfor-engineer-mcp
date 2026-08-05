#!/usr/bin/env node
// npx/`bin` launcher for the Sangfor engineer MCP server (stdio transport).
// Pins cwd to the repo root and runs the TypeScript entry directly through
// tsx (same source start-mcp.sh runs), so a client only needs a stdio
// command — no shell script, no separate build step.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'apps', 'mcp-server', 'src', 'index.ts');

if (!existsSync(entry)) {
  process.stderr.write(`sangfor-engineer-mcp: server entry not found at ${entry}\n`);
  process.exit(1);
}

let tsxCli;
try {
  tsxCli = createRequire(import.meta.url).resolve('tsx/cli', { paths: [repoRoot] });
} catch {
  process.stderr.write(`sangfor-engineer-mcp: tsx is not installed under ${repoRoot}. Run "pnpm install" there first.\n`);
  process.exit(1);
}

// Spawn the node binary directly against tsx's CLI entry (no shell, no
// pnpm/.bin shim) so this launcher has no shell dependency on any platform.
const child = spawn(process.execPath, [tsxCli, entry], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write(`sangfor-engineer-mcp: failed to start: ${String(err)}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
