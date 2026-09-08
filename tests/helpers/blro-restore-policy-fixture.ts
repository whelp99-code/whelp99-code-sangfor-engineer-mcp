import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { BACKUP_MANIFEST_VERSION, signManifest } from '../../scripts/lib/blro-backup-manifest.mjs';


export const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
export const readText = (path: string): string => readFileSync(path, 'utf8');

let root = '';
let privateKeyPath = '';
let publicKeyPath = '';
let otherPublicKeyPath = '';
let evidenceRoot = '';

/** A manifest body shaped exactly like a real capture, small enough to mutate per test. */
export function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function writeBackup(id: string, body: Record<string, unknown>, dumpBytes: Buffer): {
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

export const fixtureRoot = (): string => root;
export const taskPrivateKeyPath = (): string => privateKeyPath;
export const taskPublicKeyPath = (): string => publicKeyPath;
export const foreignPublicKeyPath = (): string => otherPublicKeyPath;
export const fixtureEvidenceRoot = (): string => evidenceRoot;
