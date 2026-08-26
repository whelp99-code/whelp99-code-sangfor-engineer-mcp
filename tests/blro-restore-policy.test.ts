// Unit-level refusals for the BLRO backup / restore-drill contract.
//
// Every case here names a way a backup can be a lie — a tampered manifest, a truncated dump, a
// stale schema, a fabricated evidence hash, an audit gap, a target that is not scratch — and proves
// the code refuses before it can restore anything. The PostgreSQL-backed drill lives in
// tests/blro-restore-drill-postgres.test.ts; this file needs no database.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoSecretMaterial, BACKUP_MANIFEST_VERSION, canonicalJson, parseManifest, signManifest,
  verifyManifestSignature,
} from '../scripts/lib/blro-backup-manifest.mjs';
import {
  assertBackupVerificationTarget, assertContainedPath, assertScratchTarget, parseConnection, parseFlags,
  redactTarget, scrub,
} from '../scripts/lib/blro-backup-runtime.mjs';
import {
  assertProductionRpoContract, evaluateSyncDurability, RETENTION_POLICY,
} from '../scripts/lib/blro-durability-contract.mjs';
import { resolveEvidenceObject } from '../scripts/lib/blro-evidence-objects.mjs';
import {
  assertJobsPreserved, assertPrePolicyEquality,
} from '../scripts/lib/blro-recovery-policy.mjs';
import {
  diffAgainstManifest, verifyBackupBeforeRestore, verifyEvidenceObjects, verifySchemaCompatibility,
} from '../scripts/lib/blro-restore-verify.mjs';
import { buildDrillReceipt, RTO_BUDGET_MS } from '../scripts/lib/blro-drill-receipt.mjs';
import { parseBackupCli } from '../scripts/blro-backup.mjs';
import { parseDrillCli } from '../scripts/blro-restore-drill.mjs';

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const readText = (path: string): string => readFileSync(path, 'utf8');

let root = '';
let privateKeyPath = '';
let publicKeyPath = '';
let otherPublicKeyPath = '';
let evidenceRoot = '';

/** A manifest body shaped exactly like a real capture, small enough to mutate per test. */
function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BACKUP_MANIFEST_VERSION,
    backupId: 'unit-backup',
    mode: 'task',
    capturedAt: '2026-01-01T00:00:00.000Z',
    dump: { format: 'custom', fileName: 'unit-backup.dump', bytes: 8, sha256: hex('dump') },
    postgres: {
      versionNum: 160002, versionText: '16.2', databaseName: 'blro', schemaName: 'public',
      systemIdentifier: '1', recoveryPoint: { lsn: '0/1F74AA8', inRecovery: false, timelineId: 1 },
      durability: {
        syncCommit: 'on', synchronousStandbyNames: '', walLevel: 'replica', fsync: 'on',
        fullPageWrites: 'on', archiveMode: 'off', syncReplicaCount: 0,
      },
    },
    schema: {
      migrations: [{ name: '20260607063209_init', checksum: 'abc' }],
      migrationDigest: hex('migrations'), catalogDigest: hex('catalog'), tableCount: 1,
    },
    tables: [{ table: 'BlroProject', rowCount: 1, setDigest: hex('project') }],
    relationships: [],
    epochs: [],
    auditHeads: [],
    authority: {
      outstandingApprovals: [], outstandingNonces: [], remoteJobs: [],
      indeterminateCount: 0, completedCount: 0,
    },
    evidenceObjects: [],
    rpo: { contract: 'blro.rpo.contract/1', claim: 'dump only', syncDurabilityProven: false, findings: ['archive_mode=off'] },
    ...overrides,
  };
}

function writeBackup(id: string, body: Record<string, unknown>, dumpBytes: Buffer): {
  manifestPath: string; dumpPath: string; publicKeyPath: string; evidenceRoot: string;
} {
  const dumpPath = join(root, `${id}.dump`);
  writeFileSync(dumpPath, dumpBytes);
  const signed = signManifest({
    ...body,
    dump: { format: 'custom', fileName: `${id}.dump`, bytes: dumpBytes.byteLength, sha256: createHash('sha256').update(dumpBytes).digest('hex') },
  }, privateKeyPath);
  const manifestPath = join(root, `${id}.manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
  return { manifestPath, dumpPath, publicKeyPath, evidenceRoot };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'blro-restore-policy-'));
  evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true });
  const pair = generateKeyPairSync('ed25519');
  privateKeyPath = join(root, 'task.pem');
  publicKeyPath = join(root, 'task.pub.pem');
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  otherPublicKeyPath = join(root, 'other.pub.pem');
  writeFileSync(otherPublicKeyPath, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString());
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('backup manifest signing', () => {
  it('verifies a manifest signed with the task key', () => {
    // Given a published manifest; When verified with the matching public key; Then it is accepted.
    const paths = writeBackup('happy', manifestBody(), Buffer.from('dumpdata'));
    const manifest = verifyManifestSignature(parseManifest(readText(paths.manifestPath)), publicKeyPath);
    expect(manifest.backupId).toBe('unit-backup');
  });

  it('refuses a manifest whose body was tampered with after signing', () => {
    // Given a signed manifest; When a captured digest is edited; Then the payload digest refuses.
    const paths = writeBackup('tamper', manifestBody(), Buffer.from('dumpdata'));
    const manifest = parseManifest(readText(paths.manifestPath));
    const tampered = { ...manifest, tables: [{ ...manifest.tables[0], rowCount: 999 }] };
    expect(() => verifyManifestSignature(tampered, publicKeyPath))
      .toThrowError(/BLRO_BACKUP_MANIFEST_PAYLOAD_DIGEST_MISMATCH/u);
  });

  it('refuses a manifest signed by a different key', () => {
    // Given a valid manifest; When verified against another key; Then the key digest refuses.
    const paths = writeBackup('wrongkey', manifestBody(), Buffer.from('dumpdata'));
    expect(() => verifyManifestSignature(parseManifest(readText(paths.manifestPath)), otherPublicKeyPath))
      .toThrowError(/BLRO_BACKUP_MANIFEST_KEY_MISMATCH/u);
  });

  it('refuses a signature value replaced with another valid-length signature', () => {
    // Given a signed manifest; When only the signature bytes are swapped; Then verification fails.
    const paths = writeBackup('swapsig', manifestBody(), Buffer.from('dumpdata'));
    const manifest = parseManifest(readText(paths.manifestPath));
    const forged = {
      ...manifest,
      signature: { ...manifest.signature, value: Buffer.alloc(64, 7).toString('base64') },
    };
    expect(() => verifyManifestSignature(forged, publicKeyPath))
      .toThrowError(/BLRO_BACKUP_MANIFEST_SIGNATURE_INVALID/u);
  });

  it('refuses a manifest that is not the canonical shape', () => {
    // Given JSON missing a required section; When parsed; Then the shape gate refuses.
    expect(() => parseManifest(JSON.stringify({ version: BACKUP_MANIFEST_VERSION })))
      .toThrowError(/BLRO_BACKUP_MANIFEST_SHAPE_REFUSED/u);
  });
});

describe('leaked credential material', () => {
  it.each([
    ['private key PEM', '-----BEGIN PRIVATE KEY-----\nMC4=\n-----END PRIVATE KEY-----'],
    ['database URL password', 'postgresql://blro:hunter2@10.0.0.1:5432/blro'],
    ['PGPASSWORD', 'PGPASSWORD=hunter2'],
    ['cookie', 'Set-Cookie: session=abc'],
    ['secret field', '{"privateKey": "x"}'],
  ])('refuses %s inside published bytes', (_label, payload) => {
    // Given publishable bytes carrying credential material; When gated; Then it refuses.
    expect(() => assertNoSecretMaterial(payload, 'unit'))
      .toThrowError(/BLRO_BACKUP_SECRET_MATERIAL_REFUSED/u);
  });

  it('refuses to sign a manifest whose captured state carries a credential', () => {
    // Given a capture polluted with a connection URL; When signed; Then signing refuses.
    expect(() => signManifest(manifestBody({
      rpo: { contract: 'c', claim: 'postgresql://u:p@h:5/d', syncDurabilityProven: false, findings: ['x'] },
    }), privateKeyPath)).toThrowError(/BLRO_BACKUP_SECRET_MATERIAL_REFUSED/u);
  });

  it('renders a connection as host/port/database only', () => {
    // Given a credentialed URL; When rendered for output; Then user and password are absent.
    const rendered = redactTarget(parseConnection('postgresql://blro:hunter2@127.0.0.1:5432/blro', 'unit'));
    expect(rendered).toBe('127.0.0.1:5432/blro');
    expect(scrub('connect postgresql://blro:hunter2@h/d failed')).not.toContain('hunter2');
  });
});

describe('pre-restore gates', () => {
  it('refuses a missing backup', () => {
    // Given no manifest on disk; When gated; Then the drill refuses before any DDL.
    expect(() => verifyBackupBeforeRestore({
      manifestPath: join(root, 'absent.manifest.json'), dumpPath: join(root, 'absent.dump'),
      publicKeyPath, evidenceRoot,
    })).toThrowError(/BLRO_DRILL_MANIFEST_MISSING/u);
  });

  it('refuses a missing dump beside a valid manifest', () => {
    // Given a manifest whose dump was never published; When gated; Then it refuses.
    const paths = writeBackup('nodump', manifestBody(), Buffer.from('dumpdata'));
    rmSync(paths.dumpPath);
    expect(() => verifyBackupBeforeRestore(paths)).toThrowError(/BLRO_DRILL_DUMP_MISSING/u);
  });

  it('refuses a truncated dump', () => {
    // Given a dump shortened after signing; When gated; Then the byte length refuses.
    const paths = writeBackup('truncated', manifestBody(), Buffer.from('dumpdata'));
    writeFileSync(paths.dumpPath, Buffer.from('dump'));
    expect(() => verifyBackupBeforeRestore(paths)).toThrowError(/BLRO_DRILL_DUMP_TRUNCATED/u);
  });

  it('refuses a corrupt dump of the recorded length', () => {
    // Given a dump with flipped bytes but the same size; When gated; Then the hash refuses.
    const paths = writeBackup('corrupt', manifestBody(), Buffer.from('dumpdata'));
    writeFileSync(paths.dumpPath, Buffer.from('DUMPDATA'));
    expect(() => verifyBackupBeforeRestore(paths)).toThrowError(/BLRO_DRILL_DUMP_HASH_MISMATCH/u);
  });
});

describe('schema compatibility', () => {
  const manifest = { schema: { migrations: [{ name: 'a', checksum: 'x' }, { name: 'b', checksum: 'y' }] } };

  it('accepts an exactly matching migration set', () => {
    expect(verifySchemaCompatibility(manifest, ['b', 'a'])).toBe(2);
  });

  it('refuses a backup newer than the working tree', () => {
    // Given a dump carrying a migration the tree lacks; When gated; Then it refuses.
    expect(() => verifySchemaCompatibility(manifest, ['a']))
      .toThrowError(/BLRO_DRILL_SCHEMA_NEWER_THAN_TREE/u);
  });

  it('refuses a stale backup', () => {
    // Given a tree carrying a migration the dump lacks; When gated; Then it refuses.
    expect(() => verifySchemaCompatibility(manifest, ['a', 'b', 'c']))
      .toThrowError(/BLRO_DRILL_SCHEMA_STALE/u);
  });
});

describe('evidence objects', () => {
  it('refuses a referenced object that is absent', () => {
    // Given a manifest naming an object that was never stored; When resolved; Then it refuses.
    expect(() => resolveEvidenceObject(
      { id: 'e1', contentHash: 'c', manifest: { objects: [{ objectPath: 'never/stored.json' }] } },
      evidenceRoot,
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses an object whose bytes changed after capture', () => {
    // Given a captured object hash; When the file is rewritten; Then the hash gate refuses.
    const relative = 'mutated.json';
    writeFileSync(join(evidenceRoot, relative), 'original');
    const captured = resolveEvidenceObject({ id: 'e2', contentHash: 'c', manifest: { objects: [{ objectPath: relative }] } }, evidenceRoot);
    writeFileSync(join(evidenceRoot, relative), 'mutated!');
    expect(() => verifyEvidenceObjects({
      evidenceObjects: [{ id: 'e2', projectId: 'p', contentHash: 'c', ...captured }],
    }, evidenceRoot)).toThrowError(/BLRO_DRILL_EVIDENCE_OBJECT_HASH_MISMATCH/u);
  });

  it('refuses an object path that escapes the evidence root by traversal', () => {
    // Given a traversal path; When resolved; Then containment refuses.
    expect(() => resolveEvidenceObject(
      { id: 'e3', contentHash: 'c', manifest: { objects: [{ objectPath: '../../etc/hostname' }] } },
      evidenceRoot,
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses an object path that escapes the evidence root by symlink', () => {
    // Given a symlink pointing outside the root; When resolved; Then containment refuses.
    const link = join(evidenceRoot, 'escape.json');
    rmSync(link, { force: true });
    symlinkSync('/etc/hostname', link);
    expect(() => resolveEvidenceObject(
      { id: 'e4', contentHash: 'c', manifest: { objects: [{ objectPath: 'escape.json' }] } },
      evidenceRoot,
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses a NUL byte in a path', () => {
    expect(() => assertContainedPath('a\0b', evidenceRoot, 'unit')).toThrowError(/BLRO_PATH_NUL_REFUSED/u);
  });
});

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
