import { dirname } from 'node:path';
import {
  JOURNAL_REFUSALS,
  RefusalJournalError,
  appendDurably,
  assertSecureFile,
  assertSecureRoot,
  fileIdentity,
  type FileIdentity,
} from './journal-storage.js';
import { readJournalEntries } from './refusal-journal-parser.js';
import {
  REFUSAL_JOURNAL_VERSION,
  entryHash,
  headerHash,
  journalEntrySchema,
  type JournalHeader,
  type JournalReservation,
  type JournalReservationInput,
  type OpenJournalInput,
  type RefusalJournalEntry,
} from './refusal-journal-schema.js';
import { RefusalJournalState } from './refusal-journal-state.js';

export {
  JOURNAL_REFUSALS,
  RefusalJournalError,
  appendDurably,
  assertSecureFile,
  assertSecureRoot,
  createJournalExclusively,
} from './journal-storage.js';
export type { JournalRefusal } from './journal-storage.js';
export {
  JOURNAL_HEADER_KIND,
  REFUSAL_JOURNAL_VERSION,
  journalHeaderLine,
} from './refusal-journal-schema.js';
export type {
  JournalHeader,
  JournalReservation,
  JournalReservationInput,
  OpenJournalInput,
  RefusalJournalEntry,
} from './refusal-journal-schema.js';

/**
 * Append-only, hash-chained, fsync-durable record of what JM already reserved.
 * Production only opens an operator-established journal and can only refuse.
 */
export class RefusalJournal {
  private readonly state: RefusalJournalState;
  /** The exact inode proven at open time; every append must still match it. */
  private pinned: FileIdentity | undefined;

  private constructor(
    private readonly path: string,
    private readonly expected: JournalHeader,
  ) {
    this.state = new RefusalJournalState(expected);
  }

  /** Opens an established journal. Never creates a root, file, or header. */
  static open(input: OpenJournalInput): RefusalJournal {
    assertSecureRoot(dirname(input.path));
    assertSecureFile(input.path);
    const journal = new RefusalJournal(input.path, input.expected);
    journal.pinned = fileIdentity(input.path);
    journal.load();
    return journal;
  }

  get length(): number {
    return this.state.length;
  }

  /** Re-verifies the on-disk chain; drives fail-closed readiness. */
  healthy(): boolean {
    try {
      assertSecureRoot(dirname(this.path));
      assertSecureFile(this.path);
      return readJournalEntries(this.path, this.expected).length >= this.state.length;
    } catch {
      return false;
    }
  }

  reserve(input: JournalReservationInput, recordedAt: Date): JournalReservation {
    const existing = this.state.existingReservation(input);
    if (existing) return existing;
    this.append(input, 'reserved', recordedAt);
    return { kind: 'reserved' };
  }

  /** Records the post-dispatch observation. It never carries a verdict. */
  recordIndeterminate(input: JournalReservationInput, recordedAt: Date): void {
    this.append(input, 'indeterminate', recordedAt);
  }

  private load(): void {
    for (const entry of readJournalEntries(this.path, this.expected)) {
      this.state.add(entry);
    }
  }

  private append(
    input: JournalReservationInput,
    state: RefusalJournalEntry['state'],
    recordedAt: Date,
  ): void {
    const unhashed = {
      version: REFUSAL_JOURNAL_VERSION,
      sequence: this.state.length + 1,
      previousHash: this.state.latest?.hash ?? headerHash(this.expected),
      jobId: input.jobId,
      receiptId: input.receiptId,
      requestId: input.requestId,
      capabilityJti: input.capabilityJti,
      requestDigest: input.requestDigest,
      capabilityDigest: input.capabilityDigest,
      reservationDigest: input.reservationDigest,
      state,
      recordedAt: recordedAt.toISOString(),
    } as const;
    const entry = journalEntrySchema.parse({ ...unhashed, hash: entryHash(unhashed) });
    appendDurably(this.path, `${JSON.stringify(entry)}\n`, this.pinned);
    this.state.add(entry);
  }
}
