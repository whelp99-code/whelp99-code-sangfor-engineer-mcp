import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  JOURNAL_REFUSALS,
  RefusalJournalError,
  appendDurably,
  assertSecureFile,
  assertSecureRoot,
  fileIdentity,
  type FileIdentity,
} from './journal-storage.js';

export {
  JOURNAL_REFUSALS,
  RefusalJournalError,
  appendDurably,
  assertSecureFile,
  assertSecureRoot,
  createJournalExclusively,
} from './journal-storage.js';
export type { JournalRefusal } from './journal-storage.js';

export const REFUSAL_JOURNAL_VERSION = 'jm-refusal-journal.v1' as const;
export const JOURNAL_HEADER_KIND = 'jm-refusal-journal-header.v1' as const;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const idSchema = z.string().min(1).max(200);

/**
 * The canonical first line of an operator-initialised journal. It binds the file
 * to one signed grant epoch and genesis, so a journal from another enrollment
 * can never be silently adopted.
 */
const journalHeaderSchema = z.object({
  kind: z.literal(JOURNAL_HEADER_KIND),
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: digestSchema,
  journalEpoch: z.number().int().nonnegative(),
  genesisDigest: digestSchema,
}).strict().readonly();

export type JournalHeader = z.infer<typeof journalHeaderSchema>;

const journalEntrySchema = z.object({
  version: z.literal(REFUSAL_JOURNAL_VERSION),
  sequence: z.number().int().positive(),
  previousHash: digestSchema,
  jobId: idSchema,
  receiptId: idSchema,
  requestId: idSchema,
  capabilityJti: idSchema,
  requestDigest: digestSchema,
  capabilityDigest: digestSchema,
  reservationDigest: digestSchema,
  state: z.enum(['reserved', 'indeterminate']),
  recordedAt: z.string().datetime({ offset: true }),
  hash: digestSchema,
}).strict().readonly();

export type RefusalJournalEntry = z.infer<typeof journalEntrySchema>;

export type JournalReservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'duplicate'; readonly entry: RefusalJournalEntry }
  | { readonly kind: 'conflict'; readonly entry: RefusalJournalEntry };

/** The full row a reservation stores; the KEY is the scoped job identity. */
export type JournalReservationInput = {
  readonly jobId: string;
  readonly receiptId: string;
  readonly requestId: string;
  readonly capabilityJti: string;
  readonly requestDigest: string;
  readonly capabilityDigest: string;
  readonly reservationDigest: string;
};

export type OpenJournalInput = {
  readonly path: string;
  readonly expected: JournalHeader;
};

function canonicalHeader(header: JournalHeader): string {
  return JSON.stringify({
    kind: header.kind,
    tenantId: header.tenantId,
    projectId: header.projectId,
    installationId: header.installationId,
    deviceBindingDigest: header.deviceBindingDigest,
    journalEpoch: header.journalEpoch,
    genesisDigest: header.genesisDigest,
  });
}

function entryHash(entry: Omit<RefusalJournalEntry, 'hash'>): string {
  return createHash('sha256').update([
    entry.version, String(entry.sequence), entry.previousHash, entry.jobId,
    entry.receiptId, entry.requestId, entry.capabilityJti, entry.requestDigest,
    entry.capabilityDigest, entry.reservationDigest, entry.state, entry.recordedAt,
  ].join('\u0000'), 'utf8').digest('hex');
}

/**
 * Append-only, hash-chained, fsync-durable record of what JM already reserved.
 *
 * It NEVER creates itself. An operator must pre-initialise the root and the file
 * (see the init CLI); production only ever opens an established journal and
 * refuses if anything about it is wrong. It can only refuse: it never grants
 * authority, revives a dispatch, or turns an observation into a verdict.
 */
export class RefusalJournal {
  private entries: RefusalJournalEntry[] = [];
  private byJob = new Map<string, RefusalJournalEntry>();
  private byJti = new Map<string, RefusalJournalEntry>();

  /** The exact inode proven at open time; every append must still match it. */
  private pinned: FileIdentity | undefined;

  private constructor(
    private readonly path: string,
    private readonly expected: JournalHeader,
  ) {}

  /** Opens an ESTABLISHED journal. Never creates a root, file, or header. */
  static open(input: OpenJournalInput): RefusalJournal {
    assertSecureRoot(dirname(input.path));
    assertSecureFile(input.path);
    const journal = new RefusalJournal(input.path, input.expected);
    journal.pinned = fileIdentity(input.path);
    journal.load();
    return journal;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Re-verifies the on-disk chain; drives fail-closed readiness. */
  healthy(): boolean {
    try {
      assertSecureRoot(dirname(this.path));
      assertSecureFile(this.path);
      const probe = new RefusalJournal(this.path, this.expected);
      probe.load();
      return probe.entries.length >= this.entries.length;
    } catch {
      return false;
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      throw new RefusalJournalError(JOURNAL_REFUSALS.UNREADABLE);
    }
    const lines = text.split('\n').filter((value) => value.trim().length > 0);
    const headerLine = lines[0];
    // An empty file is an empty REPLACEMENT of an established journal, not a
    // fresh start: refuse rather than silently accepting a blank history.
    if (lines.length === 0 || headerLine === undefined) {
      throw new RefusalJournalError(JOURNAL_REFUSALS.EMPTY);
    }
    const header = parseHeader(headerLine);
    if (header.genesisDigest !== this.expected.genesisDigest
      || header.journalEpoch !== this.expected.journalEpoch
      || header.tenantId !== this.expected.tenantId
      || header.projectId !== this.expected.projectId
      || header.installationId !== this.expected.installationId
      || header.deviceBindingDigest !== this.expected.deviceBindingDigest) {
      throw new RefusalJournalError(JOURNAL_REFUSALS.GENESIS_MISMATCH);
    }
    let previousHash = createHash('sha256')
      .update(canonicalHeader(header), 'utf8').digest('hex');
    let sequence = 1;
    for (const line of lines.slice(1)) {
      const entry = parseEntry(line);
      if (entry.sequence !== sequence || entry.previousHash !== previousHash) {
        throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
      }
      const { hash, ...unhashed } = entry;
      if (entryHash(unhashed) !== hash) throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
      this.index(entry);
      previousHash = entry.hash;
      sequence += 1;
    }
  }

  private index(entry: RefusalJournalEntry): void {
    this.entries.push(entry);
    if (entry.state !== 'reserved') return;
    this.byJob.set(this.jobKey(entry.jobId), entry);
    this.byJti.set(entry.capabilityJti, entry);
  }

  /**
   * The primary identity is the SCOPED JOB: tenant/project/installation/device
   * plus jobId. A second dispatch of the same job under a brand-new receipt and
   * a brand-new JTI is therefore still refused.
   */
  private jobKey(jobId: string): string {
    const scope = this.expected;
    return [
      scope.tenantId, scope.projectId, scope.installationId,
      scope.deviceBindingDigest, jobId,
    ].join('\u0000');
  }

  reserve(input: JournalReservationInput, recordedAt: Date): JournalReservation {
    const existing = this.byJob.get(this.jobKey(input.jobId));
    if (existing) {
      // Byte-identical retry is a duplicate; anything else about the same job is
      // a conflict. Neither dispatches.
      const identical = existing.receiptId === input.receiptId
        && existing.requestId === input.requestId
        && existing.capabilityJti === input.capabilityJti
        && existing.requestDigest === input.requestDigest
        && existing.capabilityDigest === input.capabilityDigest
        && existing.reservationDigest === input.reservationDigest;
      return identical
        ? { kind: 'duplicate', entry: existing }
        : { kind: 'conflict', entry: existing };
    }
    // The same JTI may never be spent on a different job.
    const spent = this.byJti.get(input.capabilityJti);
    if (spent) return { kind: 'conflict', entry: spent };
    this.append(input, 'reserved', recordedAt);
    return { kind: 'reserved' };
  }

  /** Records the post-dispatch observation. It never carries a verdict. */
  recordIndeterminate(input: JournalReservationInput, recordedAt: Date): void {
    this.append(input, 'indeterminate', recordedAt);
  }

  private append(
    input: JournalReservationInput,
    state: RefusalJournalEntry['state'],
    recordedAt: Date,
  ): void {
    const previous = this.entries.at(-1);
    const unhashed = {
      version: REFUSAL_JOURNAL_VERSION,
      sequence: this.entries.length + 1,
      previousHash: previous?.hash ?? createHash('sha256')
        .update(canonicalHeader(this.expected), 'utf8').digest('hex'),
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
    this.index(entry);
  }
}

function parseHeader(line: string): JournalHeader {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.HEADER_MISSING);
  }
  const parsed = journalHeaderSchema.safeParse(candidate);
  if (!parsed.success) throw new RefusalJournalError(JOURNAL_REFUSALS.HEADER_MISSING);
  return parsed.data;
}

function parseEntry(line: string): RefusalJournalEntry {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
  }
  const parsed = journalEntrySchema.safeParse(candidate);
  if (!parsed.success) throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
  return parsed.data;
}

export function journalHeaderLine(header: JournalHeader): string {
  return `${canonicalHeader(journalHeaderSchema.parse(header))}\n`;
}
