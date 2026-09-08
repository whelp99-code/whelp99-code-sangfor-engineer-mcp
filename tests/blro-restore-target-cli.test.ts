import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoSecretMaterial, BACKUP_MANIFEST_VERSION, canonicalJson, parseManifest, signManifest,
  verifyManifestSignature,
} from '../scripts/lib/blro-backup-manifest.mjs';
import {
  assertBackupVerificationTarget, assertContainedPath, assertScratchTarget, parseConnection, parseFlags,
  redactTarget, scrub,
} from '../scripts/lib/blro-backup-runtime.mjs';
import { assertProductionRpoContract, evaluateSyncDurability, RETENTION_POLICY } from '../scripts/lib/blro-durability-contract.mjs';
import { resolveEvidenceObject } from '../scripts/lib/blro-evidence-objects.mjs';
import { assertJobsPreserved, assertPrePolicyEquality } from '../scripts/lib/blro-recovery-policy.mjs';
import { diffAgainstManifest, verifyBackupBeforeRestore, verifyEvidenceObjects, verifySchemaCompatibility } from '../scripts/lib/blro-restore-verify.mjs';
import { buildDrillReceipt, RTO_BUDGET_MS } from '../scripts/lib/blro-drill-receipt.mjs';
import { parseBackupCli } from '../scripts/blro-backup.mjs';
import { parseDrillCli } from '../scripts/blro-restore-drill.mjs';
import {
  fixtureEvidenceRoot, fixtureRoot, foreignPublicKeyPath, hex, manifestBody, readText,
  taskPrivateKeyPath, taskPublicKeyPath, writeBackup,
} from './helpers/blro-restore-policy-fixture.js';

describe('scratch target contract', () => {
  const source = parseConnection('postgresql://u:p@127.0.0.1:55432/blro', 'source');

  it('accepts a loopback scratch-prefixed target', () => {
    const target = assertScratchTarget(parseConnection('postgresql://u:p@127.0.0.1:55432/blro_scratch_ok', 't'), source);
    expect(target.database).toBe('blro_scratch_ok');
  });

  it('refuses a non-loopback target', () => {
    expect(() => assertScratchTarget(parseConnection('postgresql://u:p@10.0.0.5:5432/blro_scratch_x', 't'), source))
      .toThrowError(/BLRO_DRILL_TARGET_NOT_LOOPBACK/u);
  });

  it('refuses a target without the reserved scratch prefix', () => {
    expect(() => assertScratchTarget(parseConnection('postgresql://u:p@127.0.0.1:55432/blro_prod', 't'), source))
      .toThrowError(/BLRO_DRILL_TARGET_NOT_SCRATCH/u);
  });

  it('refuses a target equal to the source', () => {
    // Given a source that happens to carry the scratch prefix; When targeted; Then equality refuses.
    const scratchSource = parseConnection('postgresql://u:p@127.0.0.1:55432/blro_scratch_same', 's');
    expect(() => assertScratchTarget(parseConnection('postgresql://u:p@127.0.0.1:55432/blro_scratch_same', 't'), scratchSource))
      .toThrowError(/BLRO_DRILL_TARGET_EQUALS_SOURCE/u);
  });

  it('refuses a non-postgres connection scheme', () => {
    expect(() => parseConnection('mysql://u:p@127.0.0.1/blro', 't'))
      .toThrowError(/BLRO_CONNECTION_SCHEME_REFUSED/u);
  });

  it('reserves backup verification to the exact local admin identity and namespace', () => {
    const admin = parseConnection('postgresql://admin:p@127.0.0.1:55432/postgres', 'a');
    const target = parseConnection('postgresql://admin:p@127.0.0.1:55432/blro_scratch_backup_verify_unit', 't');
    expect(assertBackupVerificationTarget(target, source, admin)).toBe(target);
    expect(() => assertBackupVerificationTarget(
      parseConnection('postgresql://admin:p@127.0.0.1:55432/blro_scratch_other', 't'), source, admin,
    )).toThrowError(/BLRO_BACKUP_VERIFICATION_TARGET_NOT_RESERVED/u);
    expect(() => assertBackupVerificationTarget(
      parseConnection('postgresql://other:p@127.0.0.1:55432/blro_scratch_backup_verify_unit', 't'), source, admin,
    )).toThrowError(/BLRO_BACKUP_VERIFICATION_ADMIN_MISMATCH/u);
  });
});
describe('CLI contracts', () => {
  it('defaults the backup to dry run and requires an exact verification scratch target on apply', () => {
    // Given no --apply; Then the parsed intent is a dry run.
    expect(parseBackupCli(['--out', 'o', '--signing-key', 'k']).apply).toBe(false);
    // Given --apply without its isolated verification target; Then publication is refused.
    expect(() => parseBackupCli(['--out', 'o', '--signing-key', 'k', '--apply']))
      .toThrowError(/BLRO_BACKUP_VERIFICATION_TARGET_REQUIRED/u);
    expect(parseBackupCli([
      '--out', 'o', '--signing-key', 'k', '--apply',
      '--verification-scratch-target', 'postgresql://admin:p@127.0.0.1:5432/blro_scratch_backup_verify_unit',
    ]).apply).toBe(true);
  });

  it('refuses a backup without an output directory or signing key', () => {
    expect(() => parseBackupCli(['--signing-key', 'k'])).toThrowError(/BLRO_BACKUP_OUT_REQUIRED/u);
    expect(() => parseBackupCli(['--out', 'o'])).toThrowError(/BLRO_BACKUP_SIGNING_KEY_REQUIRED/u);
  });

  it('refuses a drill without an explicit scratch target', () => {
    expect(() => parseDrillCli([
      '--backup-dir', 'd', '--backup-id', 'i', '--public-key', 'p', '--signing-key', 's',
    ])).toThrowError(/BLRO_DRILL_ARGUMENT_REQUIRED: --scratch-target/u);
  });

  it('refuses unknown, duplicated and value-less flags', () => {
    expect(() => parseFlags(['--nope', 'x'], ['--out'], [])).toThrowError(/BLRO_CLI_UNKNOWN_ARGUMENT/u);
    expect(() => parseFlags(['--out', 'a', '--out', 'b'], ['--out'], [])).toThrowError(/BLRO_CLI_DUPLICATE_ARGUMENT/u);
    expect(() => parseFlags(['--out'], ['--out'], [])).toThrowError(/BLRO_CLI_VALUE_REQUIRED/u);
  });
});
