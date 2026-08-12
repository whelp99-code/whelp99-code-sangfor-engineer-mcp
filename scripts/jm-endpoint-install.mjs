#!/usr/bin/env node
/**
 * JM endpoint install / doctor CLI.
 *
 *   node scripts/jm-endpoint-install.mjs            # print the ordered install plan
 *   node scripts/jm-endpoint-install.mjs --json     # machine-readable plan
 *   node scripts/jm-endpoint-install.mjs --doctor   # read-only host diagnosis + preflight
 *   node scripts/jm-endpoint-install.mjs --run      # execute the safe install steps
 *
 * `--run` executes only loopback-safe, non-mutating setup commands. It never
 * enables an execution gate, never touches a customer device, and never needs
 * customer credentials. Enabling real execution stays a human, per-window act.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { planJmEndpointInstall } from './lib/jm-endpoint-install.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const doctor = argv.includes('--doctor');
const run = argv.includes('--run');

const plan = planJmEndpointInstall({
  host: {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
  },
  env: process.env,
  mode: doctor ? 'doctor' : 'install',
});

if (asJson) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
  process.stdout.write(`JM endpoint ${plan.mode} plan — ${plan.host.platform}/${plan.host.arch}, node ${plan.host.nodeMajor}\n\n`);
  for (const [index, step] of plan.steps.entries()) {
    const state = step.skipped ? 'SKIP' : 'STEP';
    process.stdout.write(`[${state}] ${index + 1}. ${step.title}\n    $ ${step.command}\n    ${step.detail}\n`);
  }
  for (const warning of plan.warnings) process.stdout.write(`\n[WARN] ${warning}\n`);
  process.stdout.write(`\n${plan.summary}\n`);
}

if (!plan.supported) {
  process.exitCode = 1;
} else if (run) {
  // Execute only the steps this tool owns end-to-end. The mock smoke needs two
  // terminals, so it stays operator-driven and is reported, never auto-started.
  const executable = plan.steps.filter((step) => !step.skipped && step.id !== 'mock_smoke');
  for (const step of executable) {
    process.stdout.write(`\n=== run: ${step.id} ===\n$ ${step.command}\n`);
    const result = spawnSync(step.command, { shell: true, stdio: 'inherit' });
    if (result.status !== 0) {
      process.stdout.write(`\nJM_ENDPOINT_INSTALL_FAILED: ${step.id} exited ${result.status}\n`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) process.stdout.write('\nJM_ENDPOINT_INSTALL_COMPLETE\n');
} else if (doctor) {
  const result = spawnSync('node', ['scripts/jm-endpoint-preflight.mjs'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
