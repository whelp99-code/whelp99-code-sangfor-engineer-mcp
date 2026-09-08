import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JOURNAL_HEADER_KIND,
  RefusalJournal,
  RefusalJournalError,
  appendDurably,
  createJournalExclusively,
  journalHeaderLine,
  type JournalHeader,
  type JournalReservationInput,
  type RefusalJournalEntry,
} from '../packages/sangfor-jm-agent/src/refusal-journal.js';
import { journalEntrySchema } from '../packages/sangfor-jm-agent/src/refusal-journal-schema.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const recordedAt = new Date('2026-08-31T00:00:00.000Z');
const header: JournalHeader = {
  kind: JOURNAL_HEADER_KIND,
  tenantId: 'tenant',
  projectId: 'project',
  installationId: 'installation',
  deviceBindingDigest: digest('device'),
  journalEpoch: 7,
  genesisDigest: digest('genesis'),
};
const reservation: JournalReservationInput = {
  jobId: 'job',
  receiptId: 'receipt',
  requestId: 'request',
  capabilityJti: 'jti',
  requestDigest: digest('request'),
  capabilityDigest: digest('capability'),
  reservationDigest: digest('reservation'),
};

/** Temporary journal roots accumulated for deterministic teardown. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createJournal(): string {
  const parent = mkdtempSync(join(tmpdir(), 'refusal-mutation-'));
  roots.push(parent);
  const root = join(parent, 'journal');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, 'refusals.jsonl');
  createJournalExclusively(path);
  appendDurably(path, journalHeaderLine(header));
  return path;
}

function open(path: string): RefusalJournal {
  return RefusalJournal.open({ path, expected: header });
}

function refusalReason(path: string): string {
  try {
    open(path);
    expect.unreachable('corrupt journal must refuse');
  } catch (error) {
    if (error instanceof RefusalJournalError) return error.reason;
    throw error;
  }
}

function persistedEntry(path: string): RefusalJournalEntry {
  const line = readFileSync(path, 'utf8').trim().split('\n')[1];
  if (line === undefined) throw new TypeError('test journal entry is missing');
  return journalEntrySchema.parse(JSON.parse(line));
}

const chainMutations: readonly [string, (entry: RefusalJournalEntry) => unknown][] = [
  ['sequence', (entry) => ({ ...entry, sequence: entry.sequence + 1 })],
  ['previous hash', (entry) => ({ ...entry, previousHash: digest('foreign') })],
  ['hashed authority reference', (entry) => ({ ...entry, receiptId: 'foreign-receipt' })],
  ['entry hash', (entry) => ({ ...entry, hash: digest('forged') })],
];

describe('refusal journal parser and hash-chain mutation resistance', () => {
  it.each(chainMutations)('refuses a mutated %s', (_name, mutate) => {
    // Given a valid persisted reservation
    const path = createJournal();
    open(path).reserve(reservation, recordedAt);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const headerLine = lines[0];
    if (headerLine === undefined) throw new TypeError('test journal header is missing');

    // When one chain-bearing field is mutated
    writeFileSync(path, `${headerLine}\n${JSON.stringify(mutate(persistedEntry(path)))}\n`);

    // Then the complete journal refuses as corrupt
    expect(refusalReason(path)).toBe('JOURNAL_CORRUPT');
  });

  it('classifies malformed header JSON as a missing header', () => {
    // Given an established journal with invalid header JSON
    const path = createJournal();
    writeFileSync(path, '{not-json}\n');

    // When the journal is opened, then the header refusal remains specific
    expect(refusalReason(path)).toBe('JOURNAL_HEADER_MISSING');
  });

  it('classifies malformed entry JSON as corruption', () => {
    // Given the canonical header followed by invalid entry JSON
    const path = createJournal();
    writeFileSync(path, `${journalHeaderLine(header)}{not-json}\n`);

    // When the journal is opened, then the entry refusal remains corruption
    expect(refusalReason(path)).toBe('JOURNAL_CORRUPT');
  });
});

const identityMutations: readonly [string, Partial<JournalReservationInput>][] = [
  ['receiptId', { receiptId: 'other-receipt' }],
  ['requestId', { requestId: 'other-request' }],
  ['capabilityJti', { capabilityJti: 'other-jti' }],
  ['requestDigest', { requestDigest: digest('other-request') }],
  ['capabilityDigest', { capabilityDigest: digest('other-capability') }],
  ['reservationDigest', { reservationDigest: digest('other-reservation') }],
];

describe('refusal journal reservation identity mutation resistance', () => {
  it.each(identityMutations)('treats a changed %s as a conflict', (_name, mutation) => {
    // Given a reserved scoped job identity
    const journal = open(createJournal());
    journal.reserve(reservation, recordedAt);

    // When one authority reference changes on the same scoped job
    const outcome = journal.reserve({ ...reservation, ...mutation }, recordedAt);

    // Then it is a conflict rather than an identical retry
    expect(outcome.kind).toBe('conflict');
  });

  it('does not let an indeterminate observation spend reservation identity', () => {
    // Given only a post-dispatch observation exists
    const journal = open(createJournal());
    journal.recordIndeterminate(reservation, recordedAt);

    // When the same identity is reserved
    const outcome = journal.reserve(reservation, recordedAt);

    // Then reservation remains available and both records are retained
    expect(outcome.kind).toBe('reserved');
    expect(journal.length).toBe(2);
  });
});
