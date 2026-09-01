import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JOURNAL_REFUSALS, RefusalJournalError } from './journal-storage.js';

export const REFUSAL_JOURNAL_VERSION = 'jm-refusal-journal.v1' as const;
export const JOURNAL_HEADER_KIND = 'jm-refusal-journal-header.v1' as const;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const idSchema = z.string().min(1).max(200);

/** A journal is bound to one signed grant epoch and genesis. */
export const journalHeaderSchema = z.object({
  kind: z.literal(JOURNAL_HEADER_KIND),
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: digestSchema,
  journalEpoch: z.number().int().nonnegative(),
  genesisDigest: digestSchema,
}).strict().readonly();

export type JournalHeader = z.infer<typeof journalHeaderSchema>;

export const journalEntrySchema = z.object({
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

/** The full row a reservation stores; the key is the scoped job identity. */
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

export function canonicalHeader(header: JournalHeader): string {
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

export function headerHash(header: JournalHeader): string {
  return createHash('sha256').update(canonicalHeader(header), 'utf8').digest('hex');
}

export function entryHash(entry: Omit<RefusalJournalEntry, 'hash'>): string {
  return createHash('sha256').update([
    entry.version, String(entry.sequence), entry.previousHash, entry.jobId,
    entry.receiptId, entry.requestId, entry.capabilityJti, entry.requestDigest,
    entry.capabilityDigest, entry.reservationDigest, entry.state, entry.recordedAt,
  ].join('\u0000'), 'utf8').digest('hex');
}

export function parseJournalHeader(line: string): JournalHeader {
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

export function parseJournalEntry(line: string): RefusalJournalEntry {
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
