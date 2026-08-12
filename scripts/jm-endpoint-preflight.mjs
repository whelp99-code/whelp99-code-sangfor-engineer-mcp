#!/usr/bin/env node
/**
 * JM endpoint preflight CLI.
 *
 * Reports whether THIS host is ready to act as a JM browser execution edge.
 * Fail-closed: any unmet requirement exits non-zero with an explicit reason
 * code. Safe to run with no customer network, credentials, or browser session:
 * it inspects local configuration only and never opens a console.
 *
 *   node scripts/jm-endpoint-preflight.mjs
 *   node scripts/jm-endpoint-preflight.mjs --json
 */
import { accessSync, constants } from 'node:fs';
import process from 'node:process';
import { evaluateJmEndpointPreflight } from './lib/jm-endpoint-preflight.mjs';

const asJson = process.argv.includes('--json');

const report = evaluateJmEndpointPreflight({
  env: process.env,
  probes: {
    executableExists: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    nodeMajor: () => Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
  },
});

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.id}: ${check.detail}\n`);
  }
  process.stdout.write(`\n${report.summary}\n`);
}

process.exitCode = report.exitCode;
