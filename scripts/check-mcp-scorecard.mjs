#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(root, 'scripts/run-mcp-server-probe.mjs');
// Floor locks the customer-readiness grade. The server scores 96/100 (grade A);
// the only non-PASS check (annotations) is a deliberate fail-closed choice — see
// docs/plans/work/tech-debt-tracker.md #7. Do not lower this without cause.
const minScore = process.env.SANGFOR_MCP_SCORECARD_MIN ?? '90';

const result = spawnSync(
  'npx',
  ['-y', 'mcp-scorecard@0.3.0', probe, '--min-score', minScore],
  { cwd: root, stdio: 'inherit', env: process.env }
);

process.exit(result.status ?? 1);
