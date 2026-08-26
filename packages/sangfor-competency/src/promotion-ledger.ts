import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { withDirLock } from '../../shared/src/index.js';
import { z } from 'zod';
import {
  PROMOTION_GENESIS,
  assertCheckpointMatches,
  assertCheckpointPrefix,
  assertPromotionSecrets,
  assertPromotionStoreFiles,
  checkpointHashSchema,
  initializePromotionStore,
  promotionCheckpointPath,
  readPromotionCheckpoint,
  writePromotionCheckpoint,
} from './promotion-checkpoint.js';
import {
  PromotionLedgerIndeterminateError,
  PromotionLedgerStaleStateError,
  PromotionLedgerUnavailableError,
} from './promotion-ledger-errors.js';
import { capabilityTargetSchema, evidenceIdSchema, sha256Schema, timestampSchema, type CapabilityTarget } from './evidence-primitives.js';
import { MATURITIES, type Maturity } from './schema.js';

const LEDGER_DOMAIN = 'sangfor.capability-promotion-ledger.v1';
const promotionLedgerEventFields = {
  version: z.literal(1), seq: z.number().int().nonnegative(), eventId: evidenceIdSchema, at: timestampSchema,
  outcome: z.enum(['applied', 'rejected']), action: z.enum(['promote', 'emergency_demote', 'reject']),
  target: capabilityTargetSchema, fromMaturity: z.enum(MATURITIES), toMaturity: z.enum(MATURITIES),
  decisionRef: sha256Schema, manifestRef: sha256Schema, nonceRef: sha256Schema.nullable(),
  refusalCode: evidenceIdSchema.nullable(), prevHash: checkpointHashSchema,
} as const;
const unsignedPromotionLedgerEventSchema = z.object(promotionLedgerEventFields).strict().readonly();
const promotionLedgerEventSchema = z.object({ ...promotionLedgerEventFields, hash: sha256Schema }).strict().readonly();

export type PromotionLedgerEvent = z.infer<typeof promotionLedgerEventSchema>;
export type PromotionLedgerEventInput = {
  readonly version: 1;
  readonly eventId: string;
  readonly at: string;
  readonly outcome: 'applied' | 'rejected';
  readonly action: 'promote' | 'emergency_demote' | 'reject';
  readonly target: CapabilityTarget;
  readonly fromMaturity: Maturity;
  readonly toMaturity: Maturity;
  readonly decisionRef: string;
  readonly manifestRef: string;
  readonly nonceRef: string | null;
  readonly refusalCode: string | null;
};
export type PromotionLedgerFaults = {
  readonly afterEventDurable?: () => void;
  readonly afterCheckpointDurable?: () => void;
};
export interface PromotionLedger {
  read(): readonly PromotionLedgerEvent[] | Promise<readonly PromotionLedgerEvent[]>;
  append(event: PromotionLedgerEventInput): PromotionLedgerEvent | Promise<PromotionLedgerEvent>;
}
export {
  PromotionLedgerIndeterminateError,
  PromotionLedgerStaleStateError,
  PromotionLedgerUnavailableError,
};

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new PromotionLedgerUnavailableError();
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function eventHash(secret: string, event: Omit<PromotionLedgerEvent, 'hash'>): string {
  return createHmac('sha256', secret).update(`${LEDGER_DOMAIN}\n${canonical(event)}`, 'utf8').digest('hex');
}
export function maskedPromotionRef(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0${value}`, 'utf8').digest('hex');
}
function parseLines(source: string, secret: string): readonly PromotionLedgerEvent[] {
  const events: PromotionLedgerEvent[] = [];
  let previous: string = PROMOTION_GENESIS;
  for (const [index, line] of source.split('\n').filter((value) => value.length > 0).entries()) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new PromotionLedgerUnavailableError(); }
    const parsed = promotionLedgerEventSchema.safeParse(raw);
    if (!parsed.success) throw new PromotionLedgerUnavailableError();
    const event = parsed.data;
    const { hash, ...unsigned } = event;
    if (event.seq !== index || event.prevHash !== previous || hash !== eventHash(secret, unsigned)) throw new PromotionLedgerUnavailableError();
    events.push(event);
    previous = hash;
  }
  return events;
}

export class FilePromotionLedger implements PromotionLedger {
  private constructor(
    private readonly path: string,
    private readonly ledgerSecret: string,
    private readonly checkpointSecret: string,
    private readonly faults: PromotionLedgerFaults,
  ) {}

  static initialize(path: string, ledgerSecret: string, checkpointSecret: string, faults: PromotionLedgerFaults = {}): FilePromotionLedger {
    assertPromotionSecrets(ledgerSecret, checkpointSecret);
    initializePromotionStore(path, checkpointSecret);
    const ledger = new FilePromotionLedger(path, ledgerSecret, checkpointSecret, faults);
    assertPromotionStoreFiles(path);
    ledger.read();
    return ledger;
  }

  static open(path: string, ledgerSecret: string | undefined, checkpointSecret: string | undefined): FilePromotionLedger {
    if (ledgerSecret === undefined || checkpointSecret === undefined) throw new PromotionLedgerUnavailableError();
    assertPromotionSecrets(ledgerSecret, checkpointSecret);
    assertPromotionStoreFiles(path);
    return new FilePromotionLedger(path, ledgerSecret, checkpointSecret, {});
  }

  private readLedger(): readonly PromotionLedgerEvent[] {
    try { return parseLines(readFileSync(this.path, 'utf8'), this.ledgerSecret); }
    catch (error) {
      if (error instanceof PromotionLedgerUnavailableError) throw error;
      throw new PromotionLedgerUnavailableError();
    }
  }
  private readVerified(): readonly PromotionLedgerEvent[] {
    const events = this.readLedger();
    assertCheckpointMatches(readPromotionCheckpoint(this.path, this.checkpointSecret), events.map(({ hash }) => hash));
    return events;
  }
  read(): readonly PromotionLedgerEvent[] {
    return withDirLock(`${this.path}.lock`, () => this.readVerified());
  }

  append(input: PromotionLedgerEventInput): PromotionLedgerEvent {
    return withDirLock(`${this.path}.lock`, () => {
      const events = this.readVerified();
      const priorApplied = [...events].reverse().find((event) => event.outcome === 'applied'
        && event.target.productId === input.target.productId && event.target.capabilityId === input.target.capabilityId
        && event.target.toolId === input.target.toolId);
      if (input.outcome === 'applied' && priorApplied !== undefined && priorApplied.toMaturity !== input.fromMaturity) {
        throw new PromotionLedgerStaleStateError();
      }
      const previous = events.at(-1)?.hash ?? PROMOTION_GENESIS;
      const unsigned = unsignedPromotionLedgerEventSchema.parse({ ...input, seq: events.length, prevHash: previous });
      const event = promotionLedgerEventSchema.parse({ ...unsigned, hash: eventHash(this.ledgerSecret, unsigned) });
      let descriptor: number;
      try { descriptor = openSync(this.path, 'a', 0o600); }
      catch { throw new PromotionLedgerUnavailableError(); }
      try {
        appendFileSync(descriptor, `${JSON.stringify(event)}\n`);
        fsyncSync(descriptor);
        closeSync(descriptor);
      } catch {
        try { closeSync(descriptor); }
        catch (closeError) { if (!(closeError instanceof Error)) throw closeError; }
        throw new PromotionLedgerIndeterminateError();
      }
      try { this.faults.afterEventDurable?.(); }
      catch { throw new PromotionLedgerIndeterminateError(); }
      try {
        writePromotionCheckpoint(
          promotionCheckpointPath(this.path), this.checkpointSecret, events.length + 1, event.hash,
        );
        this.faults.afterCheckpointDurable?.();
      } catch { throw new PromotionLedgerIndeterminateError(); }
      return event;
    });
  }

  reconcile(): readonly PromotionLedgerEvent[] {
    return withDirLock(`${this.path}.lock`, () => {
      const events = this.readLedger();
      const hashes = events.map(({ hash }) => hash);
      assertCheckpointPrefix(readPromotionCheckpoint(this.path, this.checkpointSecret), hashes);
      writePromotionCheckpoint(
        promotionCheckpointPath(this.path), this.checkpointSecret, events.length, hashes.at(-1) ?? PROMOTION_GENESIS,
      );
      return this.readVerified();
    });
  }
  verify(): { readonly ok: boolean } {
    try { this.read(); return { ok: true }; }
    catch (error) {
      if (error instanceof PromotionLedgerUnavailableError) return { ok: false };
      throw error;
    }
  }
}
