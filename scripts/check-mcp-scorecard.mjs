#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(root, 'scripts/run-mcp-server-probe.mjs');
const minScore = process.env.SANGFOR_MCP_SCORECARD_MIN ?? '25';

const result = spawnSync(
  'npx',
  ['-y', 'mcp-scorecard@0.3.0', probe, '--min-score', minScore],
  { cwd: root, stdio: 'inherit', env: process.env }
);

process.exit(result.status ?? 1);
