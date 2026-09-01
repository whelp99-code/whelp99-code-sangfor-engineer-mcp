#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-rls-isolation.ts', ...process.argv.slice(2)], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
