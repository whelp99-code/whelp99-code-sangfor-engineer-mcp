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

describe('RPO durability contract', () => {
  const proven = [
    { name: 'synchronous_commit', setting: 'remote_apply' },
    { name: 'wal_level', setting: 'replica' },
    { name: 'fsync', setting: 'on' },
    { name: 'full_page_writes', setting: 'on' },
    { name: 'archive_mode', setting: 'on' },
    { name: 'synchronous_standby_names', setting: 'ANY 1 (standby_a)' },
  ];

  it('proves RPO0 only with synchronous durability AND a live sync replica', () => {
    // Given every required setting and one in-sync standby; Then the claim is RPO=0.
    const evaluation = evaluateSyncDurability(proven, 1);
    expect(evaluation.syncDurabilityProven).toBe(true);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.claim).toMatch(/RPO=0 for committed job\/nonce\/audit authority/u);
  });

  it('never claims RPO0 from the dump alone when a standby is absent', () => {
    // Given correct settings but zero replicas in sync; Then the claim degrades honestly.
    const evaluation = evaluateSyncDurability(proven, 0);
    expect(evaluation.syncDurabilityProven).toBe(false);
    expect(evaluation.claim).toMatch(/It is NOT zero/u);
  });

  it.each([
    ['synchronous_commit', 'local'],
    ['wal_level', 'minimal'],
    ['fsync', 'off'],
    ['full_page_writes', 'off'],
    ['archive_mode', 'off'],
  ])('records a finding when %s is %s', (name, setting) => {
    const evaluation = evaluateSyncDurability(
      proven.map((row) => (row.name === name ? { name, setting } : row)), 1,
    );
    expect(evaluation.syncDurabilityProven).toBe(false);
    expect(evaluation.findings.join('\n')).toContain(name);
  });

  it('fails production readiness when durability evidence is absent', () => {
    // Given unproven durability; When asserted in production mode; Then readiness refuses.
    const evaluation = evaluateSyncDurability(proven, 0);
    expect(() => assertProductionRpoContract(evaluation, 'production'))
      .toThrowError(/BLRO_RPO_SYNC_DURABILITY_UNPROVEN/u);
    expect(assertProductionRpoContract(evaluation, 'task')).toBe(evaluation);
  });

  it('excludes keys, cookies, session state and customer credentials from retention', () => {
    // Given the retention policy; Then each excluded class is named explicitly.
    const excluded = RETENTION_POLICY.excluded.join('\n');
    expect(excluded).toMatch(/private signing keys/u);
    expect(excluded).toMatch(/cookies and session state/u);
    expect(excluded).toMatch(/customer console credentials/u);
    expect(RETENTION_POLICY.worm).toMatch(/object-lock/u);
    expect(RETENTION_POLICY.owner.length).toBeGreaterThan(0);
  });
});

describe('drill receipt', () => {
  const inputs = {
    manifest: {
      backupId: 'b', signature: { payloadSha256: hex('p') }, dump: { sha256: hex('d') },
      postgres: { recoveryPoint: { lsn: '0/1', inRecovery: false, timelineId: 1 } },
      rpo: { contract: 'c', claim: 'k', syncDurabilityProven: false, findings: ['f'] },
    },
    recovery: { committedRows: 37 },
    policy: [], replay: [],
    recaptured: { tables: [{ table: 't' }], relationships: [], auditHeads: [], evidenceObjects: [] },
    postPolicy: { authority: { indeterminateCount: 1, completedCount: 1, remoteJobs: [] } },
    source: 'h:1/s', target: 'h:1/blro_scratch_t',
  };

  it('records the measured RTO inside the 60-minute budget', () => {
    const receipt = buildDrillReceipt({ ...inputs, rtoMs: 686 });
    expect(receipt.drill.withinBudget).toBe(true);
    expect(receipt.drill.rtoBudgetMs).toBe(RTO_BUDGET_MS);
    expect(receipt.preserved.indeterminate).toBe(1);
  });

  it('refuses a receipt whose RTO exceeded the budget', () => {
    // Given a drill slower than 60 minutes; Then no PASS receipt may be built.
    expect(() => buildDrillReceipt({ ...inputs, rtoMs: RTO_BUDGET_MS + 1 }))
      .toThrowError(/BLRO_DRILL_RTO_EXCEEDED/u);
  });
});

describe('canonical bytes', () => {
  it('orders object keys independently of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('preserves array order, which carries meaning in a chain', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
