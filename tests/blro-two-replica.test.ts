import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createHarnessAuthorityDatabase } from '../scripts/lib/blro-two-replica-database.js';
import { awaitConcurrentExecutionProof } from '../scripts/lib/blro-two-replica-scenarios.js';
import { createTaskCertificateFixture } from './helpers/blro-certificate-fixture.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
} from './helpers/jm-agent-fixture.js';

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
  const [code] = await once(child, 'close', { signal: timeout });
  return { code: typeof code === 'number' ? code : null, stdout, stderr };
}

describe.skipIf(!databaseUrl)('BLRO two-live-replica production harness', () => {
  it('holds the database lease before binding process-global harness resources', async () => {
    // Given: the exact production PostgreSQL owner and a valid enrollment certificate.
    const root = mkdtempSync(join(tmpdir(), 'blro-two-replica-lease-test-'));
    const certificate = createTaskCertificateFixture(root, JM_INSTALLATION_ID, JM_DEVICE_DIGEST);
    const database = await createHarnessAuthorityDatabase({
      databaseUrl: databaseUrl ?? '',
      ownerUrl: process.env.BLRO_OWNER_DATABASE_URL ?? '',
      certificateDerBase64: certificate.validDerBase64,
      trustedIssuerBundle: certificate.trustedCaPem,
    });
    const probe = new PrismaClient({ datasources: {
      db: { url: process.env.BLRO_OWNER_DATABASE_URL ?? '' },
    } });
    try {
      // When: another process inspects the live sessions while the fixture owns its scope.
      const rows = await probe.$queryRawUnsafe<readonly { readonly count: number }[]>(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity AS activity
        JOIN pg_locks AS lock ON lock.pid=activity.pid
        WHERE activity.application_name LIKE 'blro-two-replica-lease-%'
          AND lock.locktype='advisory' AND lock.granted=true`);
      // Then: one session-level lease excludes every competing fixed-port fixture.
      expect(rows[0]?.count).toBe(1);
    } finally {
      await probe.$disconnect();
      await database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('converges concurrent callers and proves every deterministic failpoint', async () => {
    // Given: the mandatory task PostgreSQL authority and the owned loopback ports.
    // When: two child replicas run the complete production harness.
    const output = await run(['--replicas', '2', '--attempts', '1000', '--jm-url',
      'https://127.0.0.1:39443/v1/browser-jobs']);
    // Then: only the machine-consumed completion sentinel is emitted on success.
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout.trim().split('\n').at(-1)).toBe('BLRO_TWO_REPLICA_PASS');
  }, 125_000);
});

if (required && !databaseUrl) {
  throw new TypeError('BLRO_TWO_REPLICA_POSTGRES_REQUIRED');
}

it('Given 1,000 concurrent submissions, When one reserves and a distinct duplicate waits, Then the proof completes without awaiting the other 998', async () => {
  // Given: every submission is already subscribed, while 998 lifecycle pairs remain unresolved.
  const resolvers: Array<{ readonly reserve: () => void; readonly wait: () => void }> = [];
  const submissions = Array.from({ length: 1_000 }, (_, index) => {
    let reserve = (): void => undefined;
    let wait = (): void => undefined;
    const reserved = new Promise<void>((resolve) => { reserve = resolve; });
    const waiting = new Promise<void>((resolve) => { wait = resolve; });
    resolvers.push({ reserve, wait });
    return { id: `submission-${String(index)}`, events: { reserved, waiting } };
  });

  // When: the dispatch reservation and one different duplicate waiting are observed.
  const proof = awaitConcurrentExecutionProof(submissions, 1_000);
  resolvers[0]?.reserve();
  resolvers[0]?.wait();
  resolvers[1]?.wait();

  // Then: the exact distinct pair releases the proof without reducing the fanout.
  await expect(proof).resolves.toEqual({
    reservedId: 'submission-0',
    waitingId: 'submission-1',
  });
  expect(submissions).toHaveLength(1_000);
});

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
