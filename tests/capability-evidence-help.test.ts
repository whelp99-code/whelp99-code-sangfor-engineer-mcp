import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'scripts', 'capability-evidence-cli.ts');

type CliResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function run(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', CLI, ...args], { cwd: join(import.meta.dirname, '..') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const EXPECTED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  global: ['--help'],
  parse: ['--help', '--manifest'],
  verify: ['--help', '--manifest', '--evidence-root'],
  promote: ['--help', '--manifest', '--promotion', '--evidence-root'],
  stale: ['--help', '--manifest', '--validation-context', '--evidence-root', '--promotion-ledger'],
  census: ['--help', '--json'],
  campaign: ['--help', 'scaffold', '--product', '--output'],
};

describe('capability evidence CLI help', () => {
  it.each([
    ['global', ['--help']],
    ['parse', ['parse', '--help']],
    ['verify', ['verify', '--help']],
    ['promote', ['promote', '--help']],
    ['stale', ['stale', '--help']],
    ['census', ['census', '--help']],
    ['campaign', ['campaign', '--help']],
    ['campaign', ['campaign', 'scaffold', '--help']],
  ] as const)('Given the %s help route, When requested, Then it exits zero with stable command and option tokens', async (command, args) => {
    const result = await run(args);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const help: unknown = JSON.parse(result.stdout);
    expect(help).toEqual({ sentinel: 'CAPABILITY_EVIDENCE_HELP', command, options: EXPECTED_OPTIONS[command] });
  });
});
