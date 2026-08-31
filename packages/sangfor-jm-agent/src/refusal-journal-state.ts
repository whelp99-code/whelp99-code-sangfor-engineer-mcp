import type {
  JournalHeader,
  JournalReservation,
  JournalReservationInput,
  RefusalJournalEntry,
} from './refusal-journal-schema.js';

type ExistingReservation = Exclude<JournalReservation, { readonly kind: 'reserved' }>;

/** Mutable in-memory index of the append-only journal. */
export class RefusalJournalState {
  private readonly entries: RefusalJournalEntry[] = [];
  private readonly byJob = new Map<string, RefusalJournalEntry>();
  private readonly byJti = new Map<string, RefusalJournalEntry>();

  constructor(private readonly scope: JournalHeader) {}

  get length(): number {
    return this.entries.length;
  }

  get latest(): RefusalJournalEntry | undefined {
    return this.entries.at(-1);
  }

  add(entry: RefusalJournalEntry): void {
    this.entries.push(entry);
    if (entry.state !== 'reserved') return;
    this.byJob.set(this.jobKey(entry.jobId), entry);
    this.byJti.set(entry.capabilityJti, entry);
  }

  existingReservation(input: JournalReservationInput): ExistingReservation | undefined {
    const existing = this.byJob.get(this.jobKey(input.jobId));
    if (existing) {
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
    const spent = this.byJti.get(input.capabilityJti);
    return spent ? { kind: 'conflict', entry: spent } : undefined;
  }

  private jobKey(jobId: string): string {
    return [
      this.scope.tenantId,
      this.scope.projectId,
      this.scope.installationId,
      this.scope.deviceBindingDigest,
      jobId,
    ].join('\u0000');
  }
}
