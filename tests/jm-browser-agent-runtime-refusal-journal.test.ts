import {
  chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RefusalJournal,
  RefusalJournalError,
  JOURNAL_HEADER_KIND,
  type JournalReservationInput,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_PROJECT_ID,
  JM_TENANT_ID,
  initialiseTestJournal,
} from './helpers/jm-agent-fixture.js';

describe('durable refusal journal keyed by scoped job identity', () => {
  const header = { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS };

  function freshJournal(name: string) {
    const journalRoot = join(mkdtempSync(join(tmpdir(), `journal-${name}-`)), 'jm');
    const path = initialiseTestJournal(journalRoot, header);
    return { journalRoot, path };
  }

  function open(path: string) {
    return RefusalJournal.open({
      path,
      expected: {
        kind: JOURNAL_HEADER_KIND,
        tenantId: JM_TENANT_ID,
        projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID,
        deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: header.journalEpoch,
        genesisDigest: header.genesisDigest,
      },
    });
  }

  function row(overrides: Partial<JournalReservationInput> = {}): JournalReservationInput {
    return {
      jobId: 'job-1', receiptId: 'receipt-1', requestId: 'req-1', capabilityJti: 'jti-1',
      requestDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
      reservationDigest: 'c'.repeat(64),
      ...overrides,
    };
  }

  it('reserves once and refuses the identical reservation after restart', () => {
    const { path } = freshJournal('restart');
    expect(open(path).reserve(row(), new Date()).kind).toBe('reserved');

    // A brand-new instance reading the SAME file must still refuse.
    expect(open(path).reserve(row(), new Date()).kind).toBe('duplicate');
  });

  it('refuses the same job under a BRAND NEW receipt and JTI', () => {
    const { path } = freshJournal('newreceipt');
    const journal = open(path);
    journal.reserve(row(), new Date());

    // Same scoped job, everything else fresh: still refused, never dispatched.
    const outcome = journal.reserve(row({
      receiptId: 'receipt-2', requestId: 'req-2', capabilityJti: 'jti-2',
      requestDigest: 'd'.repeat(64), reservationDigest: 'e'.repeat(64),
    }), new Date());

    expect(outcome.kind).toBe('conflict');
  });

  it('refuses the same JTI spent across any other job', () => {
    const { path } = freshJournal('jti');
    const journal = open(path);
    journal.reserve(row(), new Date());

    const outcome = journal.reserve(row({ jobId: 'job-2', receiptId: 'receipt-2' }), new Date());

    expect(outcome.kind).toBe('conflict');
  });

  it('allows multiple DISTINCT jobs sequentially', () => {
    const { path } = freshJournal('sequential');
    const journal = open(path);

    for (let index = 0; index < 5; index += 1) {
      expect(journal.reserve(row({
        jobId: `job-${String(index)}`,
        receiptId: `receipt-${String(index)}`,
        requestId: `req-${String(index)}`,
        capabilityJti: `jti-${String(index)}`,
        requestDigest: createHash('sha256').update(String(index)).digest('hex'),
      }), new Date()).kind, `job ${String(index)}`).toBe('reserved');
    }
    expect(journal.length).toBe(5);
  });

  it('NEVER auto-creates a root, a file, or a header', () => {
    const missingRoot = join(mkdtempSync(join(tmpdir(), 'journal-none-')), 'absent');

    expect(() => RefusalJournal.open({
      path: join(missingRoot, 'refusals.jsonl'),
      expected: {
        kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS,
      },
    })).toThrow(RefusalJournalError);
    expect(existsSync(missingRoot)).toBe(false);
  });

  it('refuses an insecure root or file mode, and a symlinked file', () => {
    const { journalRoot, path } = freshJournal('modes');
    chmodSync(journalRoot, 0o755);
    expect(() => open(path)).toThrow(RefusalJournalError);
    chmodSync(journalRoot, 0o700);

    chmodSync(path, 0o644);
    expect(() => open(path)).toThrow(RefusalJournalError);
    chmodSync(path, 0o600);

    const link = join(journalRoot, 'linked.jsonl');
    symlinkSync(path, link);
    expect(() => open(link)).toThrow(RefusalJournalError);
  });

  it('refuses a missing header, an empty replacement and a truncated chain', () => {
    const { path } = freshJournal('corrupt');
    const journal = open(path);
    journal.reserve(row(), new Date());
    const original = readFileSync(path, 'utf8');

    // Empty replacement of an established journal.
    writeFileSync(path, '', { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    // Header removed.
    writeFileSync(path, original.split('\n').slice(1).join('\n'), { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    // Hash-chain corruption.
    writeFileSync(path, original.replace('receipt-1', 'receipt-X'), { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    writeFileSync(path, original, { mode: 0o600 });
    expect(open(path).length).toBe(1);
  });

  it('refuses a journal whose header names another grant epoch or genesis', () => {
    const { path } = freshJournal('epoch');

    for (const wrong of [
      { kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 8, genesisDigest: JM_JOURNAL_GENESIS },
      { kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 7, genesisDigest: 'f'.repeat(64) },
    ] as const) {
      try {
        RefusalJournal.open({ path, expected: wrong });
        expect.unreachable('a foreign epoch or genesis must refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(RefusalJournalError);
        expect((error as RefusalJournalError).reason).toBe('JOURNAL_GENESIS_MISMATCH');
      }
    }
  });

  it('records the post-dispatch observation without producing a verdict', () => {
    const { path } = freshJournal('observation');
    const journal = open(path);
    journal.reserve(row(), new Date());

    journal.recordIndeterminate(row(), new Date());

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ state: 'indeterminate' });
    expect(readFileSync(path, 'utf8')).not.toContain('PASS');
  });
});
