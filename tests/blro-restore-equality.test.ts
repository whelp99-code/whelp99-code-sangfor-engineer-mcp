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

describe('post-restore equality', () => {
  const manifest = {
    tables: [{ table: 'BlroProject', rowCount: 2, setDigest: hex('p') }],
    relationships: [{ table: 'BlroRun', parent: 'BlroProject', constraint: 'fk', columns: ['projectId'], references: ['id'], deleteAction: 'r', childRows: 3 }],
    epochs: [{ projectId: 'p1', epoch: 7, revision: 0, cutovers: [] }],
    auditHeads: [{ projectId: 'p1', eventCount: 3, headSeq: 2, headHash: 'h', keyedCount: 3, chainDigest: hex('chain') }],
    evidenceObjects: [{ id: 'e', projectId: 'p1', contentHash: 'c', objectPath: 'o', objectHash: hex('o'), objectBytes: 4 }],
    schema: { migrationDigest: hex('m'), catalogDigest: hex('cat') },
    authority: { remoteJobs: [{ id: 'j', state: 'indeterminate' }], outstandingApprovals: [], outstandingNonces: [] },
  };
  const matching = {
    tables: manifest.tables, relationships: manifest.relationships, epochs: manifest.epochs,
    auditHeads: manifest.auditHeads, evidenceObjects: manifest.evidenceObjects,
    schema: manifest.schema, authority: manifest.authority,
  };

  it('reports no problems when the restore matches', () => {
    expect(diffAgainstManifest(manifest, matching)).toEqual([]);
  });

  it('reports a row-count loss', () => {
    const actual = { ...matching, tables: [{ table: 'BlroProject', rowCount: 1, setDigest: hex('p') }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('row count BlroProject: 1 != 2');
  });

  it('reports a set-digest mismatch at an equal row count', () => {
    // Given the same number of rows with different bytes; Then the set digest catches it.
    const actual = { ...matching, tables: [{ table: 'BlroProject', rowCount: 2, setDigest: hex('other') }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('set digest BlroProject');
  });

  it('reports a missing table and an extra table', () => {
    const actual = { ...matching, tables: [{ table: 'BlroGhost', rowCount: 2, setDigest: hex('p') }] };
    const problems = diffAgainstManifest(manifest, actual);
    expect(problems).toContain('table missing after restore: BlroProject');
    expect(problems).toContain('extra table after restore: BlroGhost');
  });

  it('reports a dropped foreign-key relationship', () => {
    expect(diffAgainstManifest(manifest, { ...matching, relationships: [] })).toContain('relationship set');
  });

  it('reports a changed child cardinality on an intact relationship', () => {
    const actual = { ...matching, relationships: [{ ...manifest.relationships[0], childRows: 2 }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('relationship set');
  });

  it('reports an audit chain gap', () => {
    const actual = { ...matching, auditHeads: [{ ...manifest.auditHeads[0], eventCount: 2, headSeq: 1 }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('audit chain heads');
  });

  it('reports an audit head hash mismatch', () => {
    const actual = { ...matching, auditHeads: [{ ...manifest.auditHeads[0], headHash: 'other' }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('audit chain heads');
  });

  it('reports an unkeyed chain where the backup recorded keyed events', () => {
    const actual = { ...matching, auditHeads: [{ ...manifest.auditHeads[0], keyedCount: 0 }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('audit chain heads');
  });

  it('reports a lost evidence object', () => {
    expect(diffAgainstManifest(manifest, { ...matching, evidenceObjects: [] })).toContain('evidence objects');
  });

  it('reports an extra evidence object the backup never recorded', () => {
    const actual = {
      ...matching,
      evidenceObjects: [...manifest.evidenceObjects, { id: 'x', projectId: 'p1', contentHash: 'c2', objectPath: 'o2', objectHash: hex('o2'), objectBytes: 1 }],
    };
    expect(diffAgainstManifest(manifest, actual)).toContain('evidence objects');
  });

  it('reports an epoch that does not match the backup point', () => {
    const actual = { ...matching, epochs: [{ projectId: 'p1', epoch: 8, revision: 1, cutovers: [] }] };
    expect(diffAgainstManifest(manifest, actual)).toContain('authority epochs');
  });

  it('blocks the recovery policy while any equality problem stands', () => {
    // Given a non-empty problem list; When the policy gate runs; Then it refuses to mutate.
    expect(() => assertPrePolicyEquality(['set digest BlroProject']))
      .toThrowError(/BLRO_DRILL_PRE_POLICY_EQUALITY_FAILED/u);
    expect(assertPrePolicyEquality([])).toBeUndefined();
  });
});
describe('recovery policy uncertainty', () => {
  const before = [
    { id: 'a', state: 'result_retained', resultDigest: hex('r') },
    { id: 'b', state: 'indeterminate', resultDigest: null },
  ];

  it('accepts an untouched tombstone set', () => {
    expect(assertJobsPreserved(before, before.map((job) => ({ ...job })))).toBe(2);
  });

  it('refuses converting INDETERMINATE to a retained result', () => {
    // Given an indeterminate job; When the policy promotes it; Then it refuses.
    const after = [before[0], { id: 'b', state: 'result_retained', resultDigest: hex('invented') }];
    expect(() => assertJobsPreserved(before, after)).toThrowError(/BLRO_RECOVERY_UNCERTAINTY_CONVERTED/u);
  });

  it('refuses deleting an INDETERMINATE job', () => {
    expect(() => assertJobsPreserved(before, [before[0]]))
      .toThrowError(/BLRO_RECOVERY_UNCERTAINTY_CONVERTED/u);
  });

  it('refuses mutating a completed result digest', () => {
    const after = [{ ...before[0], resultDigest: hex('rewritten') }, before[1]];
    expect(() => assertJobsPreserved(before, after)).toThrowError(/BLRO_RECOVERY_JOB_TOMBSTONE_MUTATED/u);
  });
});
