import {
  existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KeyRing,
  RefusalJournal,
  RefusalJournalError,
  grantSnapshotSchema,
  JOURNAL_HEADER_KIND,
  type JournalReservationInput,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_TENANT_ID,
  browserRequest,
  buildAuthorityReceipt,
  createJmSigningMaterial,
  createJmTlsMaterial,
  mintTaskCapability,
  originDigest,
  initialiseTestJournal,
  readKeyRing,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('journal append is TOCTOU-safe and never recreates a file', () => {
  const header = { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS };

  function established(name: string) {
    const journalRoot = join(mkdtempSync(join(tmpdir(), `toctou-${name}-`)), 'jm');
    const path = initialiseTestJournal(journalRoot, header);
    return { journalRoot, path };
  }

  function openJournal(path: string) {
    return RefusalJournal.open({
      path,
      expected: {
        kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: header.journalEpoch, genesisDigest: header.genesisDigest,
      },
    });
  }

  const reservation: JournalReservationInput = {
    jobId: 'job-toctou', receiptId: 'receipt-toctou', requestId: 'req-toctou',
    capabilityJti: 'jti-toctou', requestDigest: 'a'.repeat(64),
    capabilityDigest: 'b'.repeat(64), reservationDigest: 'c'.repeat(64),
  };

  it('uses no O_CREAT and no append shorthand anywhere in the storage module', () => {
    const storage = readFileSync(
      join(import.meta.dirname, '../packages/sangfor-jm-agent/src/journal-storage.ts'), 'utf8',
    );

    // The production append must never be able to bring a file back. Scope the
    // scan to appendDurably's own body: createJournalExclusively is the single
    // operator-only creator and is allowed to use O_CREAT.
    expect(storage).toContain('O_NOFOLLOW');
    expect(storage).not.toMatch(/openSync\([^,]+,\s*'a'\)/u);
    const start = storage.indexOf('export function appendDurably');
    // Strip comments: the doc block names O_CREAT precisely to explain its absence.
    const appendBody = storage
      .slice(start, storage.indexOf('\nfunction openRefusal', start))
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
    expect(appendBody).not.toContain('O_CREAT');
    expect(appendBody).toContain('APPEND_FLAGS');
    // And the flags constant itself excludes O_CREAT.
    const flags = storage.slice(storage.indexOf('const APPEND_FLAGS'));
    expect(flags.slice(0, flags.indexOf(';'))).not.toContain('O_CREAT');
  });

  it('BARRIER before open: a deletion between lstat and open refuses and recreates nothing', () => {
    const { path } = established('before-open');
    const journal = openJournal(path);

    // Given the file is removed at the exact moment before the append opens it.
    rmSync(path);
    let refusal: unknown;
    try {
      journal.reserve(reservation, new Date());
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(RefusalJournalError);
    expect((refusal as RefusalJournalError).reason).toBe('JOURNAL_NOT_ESTABLISHED');
    // Then no file was recreated by the failed append.
    expect(existsSync(path), 'fileRecreated').toBe(false);
  });

  it('BARRIER after journal open: a replacement before reservation completion refuses', () => {
    const { path } = established('after-open');
    const journal = openJournal(path);
    const original = readFileSync(path, 'utf8');
    const openedIdentity = lstatSync(path, { bigint: true });

    // Given journal open has completed, replace its path before reservation begins.
    rmSync(path);
    writeFileSync(path, original, { mode: 0o600 });
    const replacementIdentity = lstatSync(path, { bigint: true });
    expect(replacementIdentity.birthtimeNs).not.toBe(openedIdentity.birthtimeNs);

    let refusal: unknown;
    try {
      journal.reserve(reservation, new Date());
    } catch (error) {
      refusal = error;
    }

    // Then the replacement is detected: the reservation never lands on it.
    expect(refusal).toBeInstanceOf(RefusalJournalError);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('refuses a symlink swapped in for the journal file', () => {
    const { journalRoot, path } = established('symlink');
    const journal = openJournal(path);
    const decoy = join(journalRoot, 'decoy.jsonl');
    writeFileSync(decoy, readFileSync(path, 'utf8'), { mode: 0o600 });
    rmSync(path);
    symlinkSync(decoy, path);

    expect(() => journal.reserve(reservation, new Date())).toThrow(RefusalJournalError);
  });

  it('reserveAfterLoss is REFUSED, the executor never runs, and no file reappears', async () => {
    const { path } = established('afterloss');
    const journal = openJournal(path);
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;

    const { createReceiptRemoteJobStore } =
      await import('../packages/sangfor-jm-agent/src/index.js');
    const { buildRemoteJobEnvelope } =
      await import('../packages/sangfor-browser-contracts/src/index.js');
    const request = browserRequest();
    const jti = `jti-loss-${randomUUID()}`;
    const capability = mintTaskCapability(signing, request, { jti });
    const envelope = buildRemoteJobEnvelope(request, {
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, capability,
    });
    const receipt = buildAuthorityReceipt(signing, {
      request, jobId: envelope.jobId, capability, capabilityJti: jti,
      clientFingerprint: tls.clientFingerprint256,
    });
    const receiptId = (JSON.parse(Buffer.from(
      receipt.split('.')[0] ?? '', 'base64url',
    ).toString('utf8')) as { readonly receiptId: string }).receiptId;
    const snapshot = grantSnapshotSchema.parse({
      version: 'blro-enrollment-grant-snapshot.v1', snapshotId: 's',
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
      clientIdentityId: 'c', deviceBindingDigest: JM_DEVICE_DIGEST, authorityEpoch: 7,
      state: 'active',
      grants: [{ originDigest: originDigest(JM_ORIGIN), scope: 'browser:execute' }],
      journalGenesis: JM_JOURNAL_GENESIS,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const store = createReceiptRemoteJobStore({
      receiptFor: () => receipt,
      receiptIdFor: () => receiptId,
      clientFingerprintFor: () => tls.clientFingerprint256,
      snapshot: () => snapshot,
      keyRing: ring.ring,
      journal,
      allowedOrigin: JM_ORIGIN,
      now: () => new Date(),
    });

    // Given the established journal is lost after the store was built.
    rmSync(path);
    const reserved = await store.authorizeAndReserve({ envelope, certificate: undefined });

    // Then the dispatch is refused, so no executor can run, and nothing reappears.
    expect(reserved.kind, 'reserveAfterLoss').toBe('unavailable');
    expect(existsSync(path), 'fileRecreated').toBe(false);
    expect(journal.healthy()).toBe(false);
  });
});
