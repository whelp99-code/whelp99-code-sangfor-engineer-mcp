import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const required = process.env.SANGFOR_REQUIRE_POSTGRES_TESTS === '1';

async function run(arguments_: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-blro-two-replica.ts', ...arguments_], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const timeout = AbortSignal.timeout(120_000);
  const [code] = await once(child, 'exit', { signal: timeout });
  return { code: typeof code === 'number' ? code : null, stdout, stderr };
}

describe.skipIf(!databaseUrl)('BLRO two-live-replica production harness', () => {
  it('converges concurrent callers and proves every deterministic failpoint', async () => {
    // Given: the mandatory task PostgreSQL authority and the owned loopback ports.
    // When: two child replicas run the complete production harness.
    const output = await run(['--replicas', '2', '--attempts', '2', '--jm-url',
      'https://127.0.0.1:39443/v1/browser-jobs']);
    // Then: only the machine-consumed completion sentinel is emitted on success.
    expect(output).toMatchObject({ code: 0 });
    expect(output.stdout.trim().split('\n').at(-1)).toBe('BLRO_TWO_REPLICA_PASS');
  }, 125_000);
});

if (required && !databaseUrl) {
  throw new TypeError('BLRO_TWO_REPLICA_POSTGRES_REQUIRED');
}

it('locks dispatch ordering, no-retry uncertainty, revocation and event coordination', () => {
  // Given: the shipped production dispatcher and deterministic harness scenario.
  const dispatcher = readFileSync('packages/sangfor-authority/src/blro-remote-dispatcher.ts', 'utf8');
  const scenarios = readFileSync('scripts/lib/blro-two-replica-scenarios.ts', 'utf8');
  const harness = [
    readFileSync('scripts/lib/blro-two-replica-runner.ts', 'utf8'),
    readFileSync('scripts/lib/blro-two-replica-child.ts', 'utf8'),
    scenarios,
  ].join('\n');
  // When: safety-bearing machine structure is inspected.
  const reserve = dispatcher.indexOf('options.authority.reserve');
  const dispatch = dispatcher.indexOf('options.transport.dispatch');
  // Then: moving reserve after transport, adding retries, bypassing revocation,
  // or adding sleep/poll coordination fails this exact check.
  expect(reserve).toBeGreaterThanOrEqual(0);
  expect(dispatch).toBeGreaterThan(reserve);
  expect(dispatcher.match(/options\.transport\.dispatch/gu)).toHaveLength(1);
  expect(scenarios.indexOf('fixture.revoke()')).toBeLessThan(scenarios.indexOf("requestId: 'todo28-revoked'"));
  expect(harness).not.toMatch(/\b(?:setTimeout|setInterval|sleep)\s*\(/u);
});

it('refuses invalid replica configuration through the CLI boundary', async () => {
  // Given: a replica count that cannot establish the required topology.
  // When: the CLI parses the invalid input.
  const output = await run(['--replicas', '1', '--attempts', '2', '--jm-url',
    'https://127.0.0.1:39443/v1/browser-jobs']);
  // Then: startup fails without printing the success sentinel.
  expect(output.code).not.toBe(0);
  expect(output.stdout).not.toContain('BLRO_TWO_REPLICA_PASS');
});
