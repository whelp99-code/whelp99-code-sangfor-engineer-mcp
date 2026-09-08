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

describe('backup manifest signing', () => {
  it('verifies a manifest signed with the task key', () => {
    // Given a published manifest; When verified with the matching public key; Then it is accepted.
    const paths = writeBackup('happy', manifestBody(), Buffer.from('dumpdata'));
    const manifest = verifyManifestSignature(parseManifest(readText(paths.manifestPath)), taskPublicKeyPath());
    expect(manifest.backupId).toBe('unit-backup');
  });

  it('refuses a manifest whose body was tampered with after signing', () => {
    // Given a signed manifest; When a captured digest is edited; Then the payload digest refuses.
    const paths = writeBackup('tamper', manifestBody(), Buffer.from('dumpdata'));
    const manifest = parseManifest(readText(paths.manifestPath));
    const tampered = { ...manifest, tables: [{ ...manifest.tables[0], rowCount: 999 }] };
    expect(() => verifyManifestSignature(tampered, taskPublicKeyPath()))
      .toThrowError(/BLRO_BACKUP_MANIFEST_PAYLOAD_DIGEST_MISMATCH/u);
  });

  it('refuses a manifest signed by a different key', () => {
    // Given a valid manifest; When verified against another key; Then the key digest refuses.
    const paths = writeBackup('wrongkey', manifestBody(), Buffer.from('dumpdata'));
    expect(() => verifyManifestSignature(parseManifest(readText(paths.manifestPath)), foreignPublicKeyPath()))
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
    expect(() => verifyManifestSignature(forged, taskPublicKeyPath()))
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
    }), taskPrivateKeyPath())).toThrowError(/BLRO_BACKUP_SECRET_MATERIAL_REFUSED/u);
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
      manifestPath: join(fixtureRoot(), 'absent.manifest.json'), dumpPath: join(fixtureRoot(), 'absent.dump'),
      publicKeyPath: taskPublicKeyPath(), evidenceRoot: fixtureEvidenceRoot(),
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
      fixtureEvidenceRoot(),
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses an object whose bytes changed after capture', () => {
    // Given a captured object hash; When the file is rewritten; Then the hash gate refuses.
    const relative = 'mutated.json';
    writeFileSync(join(fixtureEvidenceRoot(), relative), 'original');
    const captured = resolveEvidenceObject({ id: 'e2', contentHash: 'c', manifest: { objects: [{ objectPath: relative }] } }, fixtureEvidenceRoot());
    writeFileSync(join(fixtureEvidenceRoot(), relative), 'mutated!');
    expect(() => verifyEvidenceObjects({
      evidenceObjects: [{ id: 'e2', projectId: 'p', contentHash: 'c', ...captured }],
    }, fixtureEvidenceRoot())).toThrowError(/BLRO_DRILL_EVIDENCE_OBJECT_HASH_MISMATCH/u);
  });

  it('refuses an object path that escapes the evidence root by traversal', () => {
    // Given a traversal path; When resolved; Then containment refuses.
    expect(() => resolveEvidenceObject(
      { id: 'e3', contentHash: 'c', manifest: { objects: [{ objectPath: '../../etc/hostname' }] } },
      fixtureEvidenceRoot(),
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses an object path that escapes the evidence root by symlink', () => {
    // Given a symlink pointing outside the root; When resolved; Then containment refuses.
    const link = join(fixtureEvidenceRoot(), 'escape.json');
    rmSync(link, { force: true });
    symlinkSync('/etc/hostname', link);
    expect(() => resolveEvidenceObject(
      { id: 'e4', contentHash: 'c', manifest: { objects: [{ objectPath: 'escape.json' }] } },
      fixtureEvidenceRoot(),
    )).toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE/u);
  });

  it('refuses a NUL byte in a path', () => {
    expect(() => assertContainedPath('a\0b', fixtureEvidenceRoot(), 'unit')).toThrowError(/BLRO_PATH_NUL_REFUSED/u);
  });
});
