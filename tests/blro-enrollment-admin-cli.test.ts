import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const SCRIPT = 'scripts/blro-enrollment-admin.ts';

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(args: readonly string[]): CliResult {
  const result = spawnSync('pnpm', ['exec', 'tsx', SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function output(result: CliResult): Readonly<Record<string, unknown>> {
  return z.record(z.unknown()).parse(JSON.parse(result.stdout.trim()));
}

describe('BLRO enrollment administration CLI', () => {
  it('prints machine-usable help when requested', () => {
    // Given the read-only administration entry point
    // When help is requested
    const result = run(['--help']);

    // Then every supported operation is discoverable without authority access
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('identity rotation revocation emergency rollout readiness reconcile incident');
    expect(result.stderr).toBe('');
  });

  it('refuses malformed and secret-bearing arguments with structured JSON', () => {
    // Given malformed input that attempts to cross private material into the CLI
    // When the boundary parser receives it
    const result = run(['rotation', '--private-key', 'must-not-cross']);

    // Then it fails before any operation and does not echo the value
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 'blro-enrollment-admin.v1',
      status: 'REFUSED',
      reason: 'SECRET_ARGUMENT_REFUSED',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain('must-not-cross');
  });

  it('plans one-identity rotation only within the ten-minute overlap', () => {
    // Given one installation identity and a bounded certificate overlap
    // When rotation is evaluated in default dry-run mode
    const accepted = run([
      'rotation', '--installation-id', 'jm-001', '--identity-count', '1', '--overlap-seconds', '600',
    ]);
    const refused = run([
      'rotation', '--installation-id', 'jm-001', '--identity-count', '2', '--overlap-seconds', '601',
    ]);

    // Then the valid plan is non-mutating and invalid identity/overlap state is refused
    expect(output(accepted)).toMatchObject({
      status: 'PASS', operation: 'rotation', execution: 'DRY_RUN', overlapSeconds: 600,
    });
    expect(output(refused)).toMatchObject({
      status: 'REFUSED', reason: 'INSTALLATION_IDENTITY_OR_OVERLAP_INVALID', execution: 'NOT_RUN',
    });
  });

  it('requires fresh revocation observation and BLRO-first supported rollout', () => {
    // Given fleet observations at and beyond the revocation and version boundaries
    // When the policies are evaluated
    const fresh = run(['revocation', '--installation-id', 'jm-001', '--observation-age-seconds', '60']);
    const stale = run(['revocation', '--installation-id', 'jm-001', '--observation-age-seconds', '61']);
    const supported = run(['rollout', '--blro-version', '1.1', '--jm-version', '1.0', '--blro-ready']);
    const ahead = run(['rollout', '--blro-version', '1.0', '--jm-version', '1.1', '--blro-ready']);

    // Then stale revocation and JM-ahead rollout refuse without writes
    expect(output(fresh)).toMatchObject({ status: 'PASS', freshnessSeconds: 60, execution: 'READ_ONLY' });
    expect(output(stale)).toMatchObject({ status: 'REFUSED', reason: 'REVOCATION_FRESHNESS_EXCEEDED' });
    expect(output(supported)).toMatchObject({ status: 'PASS', rolloutOrder: ['BLRO', 'JM'] });
    expect(output(ahead)).toMatchObject({ status: 'REFUSED', reason: 'PEER_CONTRACT_AHEAD' });
  });

  it('runs the package-script form used by the runbook', () => {
    // Given the documented pnpm command form
    // When the identity check runs through package.json
    const result = spawnSync('pnpm', [
      'run', 'blro:enrollment-admin', '--', 'identity',
      '--installation-id', 'jm-001', '--identity-count', '1',
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    // Then pnpm argument forwarding reaches the structured CLI boundary
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status":"PASS"');
    expect(result.stderr).toBe('');
  });

  it('runs the task-owned manual driver without real device action', () => {
    // Given the machine-checked certificate-rotation rehearsal
    // When the package driver runs
    const result = spawnSync('pnpm', ['run', 'blro:cert-rotation:verify'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });

    // Then it emits the acceptance sentinel and explicitly reports no device action
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('BLRO_CERT_ROTATION_PASS');
    expect(result.stdout).toContain('"deviceAction":false');
    expect(result.stderr).toBe('');
  });

  it('contains emergencies and reconciles post-dispatch uncertainty without retry or nonce reset', () => {
    // Given a suspected CA compromise and an indeterminate dispatched mutation
    // When operators request containment and reconciliation output
    const emergency = run(['emergency', '--incident-id', 'inc-001', '--ca-compromised']);
    const incident = run([
      'incident', '--job-id', 'job-001', '--dispatch-state', 'INDETERMINATE', '--mutation-attempted',
    ]);
    const reconcile = run([
      'reconcile', '--job-id', 'job-001', '--dispatch-state', 'INDETERMINATE',
      '--read-back', 'INDETERMINATE',
    ]);

    // Then output contains authority and preserves uncertainty without device action
    expect(output(emergency)).toMatchObject({
      status: 'CONTAINED', keyGeneration: 'EXTERNAL_CEREMONY_REQUIRED', execution: 'NOT_RUN',
    });
    expect(output(incident)).toMatchObject({
      status: 'INCIDENT', reason: 'POST_DISPATCH_OUTCOME_UNKNOWN', retryAllowed: false,
      nonceResetAllowed: false, execution: 'NOT_RUN',
    });
    expect(output(reconcile)).toMatchObject({
      status: 'REFUSED', reason: 'INDETERMINATE_REQUIRES_HUMAN_READ_BACK', execution: 'NOT_RUN',
    });
  });
});
