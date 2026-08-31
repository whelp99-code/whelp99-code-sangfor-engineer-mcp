import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'test-browser-port.ts');

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', SCRIPT, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('test-browser-port CLI', () => {
  it('Given the help route, When requested, Then it exits zero with the stable sentinel, option, and scenario tokens', async () => {
    const result = await run(['--help']);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const help: unknown = JSON.parse(result.stdout);
    expect(help).toEqual({
      sentinel: 'JM_BROWSER_PORT_QA_HELP',
      options: ['--help', '--scenario', '--base-url'],
      scenarios: ['bad-origin', 'forbidden-operation', 'local-readback'],
      defaultBaseUrl: 'http://127.0.0.1:3400/hci',
    });
  });

  it.each([
    ['no arguments', [], 'Missing --scenario.'],
    ['a valueless scenario flag', ['--scenario'], 'Missing --scenario.'],
    ['an unknown scenario', ['--scenario', 'nope'], 'Unknown scenario: nope'],
    ['an unusable base URL', ['--scenario', 'bad-origin', '--base-url', 'not-a-url'], 'Invalid URL'],
  ] as const)('Given %s, When the script runs, Then it refuses on stderr with exit code 1 and writes nothing to stdout', async (_case, args, error) => {
    const result = await run(args);

    expect(result).toMatchObject({ status: 1, stdout: '' });
    expect(JSON.parse(result.stderr)).toEqual({ status: 'FAIL', error });
  });

  it('Given the bad-origin scenario on the default base URL, When it runs, Then the port refuses the origin before any dispatch', async () => {
    const result = await run(['--scenario', 'bad-origin']);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: 'SESSION_ORIGIN_MISMATCH' },
    });
  });

  it('Given the forbidden-operation scenario, When it runs, Then the unknown operation key is refused by the request schema', async () => {
    const result = await run(['--scenario', 'forbidden-operation', '--base-url', 'http://127.0.0.1:3400/hci']);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: 'INVALID_BROWSER_REQUEST' },
    });
    // A dispatched request would have surfaced the no-op driver's guard instead.
    expect(result.stdout).toContain('selector');
    expect(result.stdout).not.toContain('Driver must not execute');
  });
});
