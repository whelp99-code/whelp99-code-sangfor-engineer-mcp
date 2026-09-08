import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expectedLocalWriteScope, requireLocalWriteAuthority, withDirLock, type LocalWriteAuthority } from '../../shared/src/index.js';
import {
  PROMOTION_GENESIS,
  assertCheckpointMatches,
  assertCheckpointPrefix,
  assertPromotionSecrets,
  assertPromotionStoreFiles,
  initializePromotionStore,
  promotionCheckpointPath,
  readPromotionCheckpoint,
  writePromotionCheckpoint,
} from './promotion-checkpoint.js';
import {
  PromotionLedgerIndeterminateError,
  PromotionLedgerStaleEvidenceError,
  PromotionLedgerStaleStateError,
  PromotionLedgerUnavailableError,
} from './promotion-ledger-errors.js';
import type { CapabilityTarget } from './evidence-primitives.js';
import {
  parsePromotionLedgerEvent,
  parseUnsignedPromotionLedgerEvent,
  type PromotionLedgerEvent,
  type PromotionLedgerEventInput,
} from './promotion-ledger-schema.js';

const LEDGER_DOMAIN = 'sangfor.capability-promotion-ledger.v1';
export type { PromotionLedgerEvent, PromotionLedgerEventInput } from './promotion-ledger-schema.js';
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
  PromotionLedgerStaleEvidenceError,
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
export function samePromotionTarget(left: CapabilityTarget, right: CapabilityTarget): boolean {
  return left.productId === right.productId && left.capabilityId === right.capabilityId && left.toolId === right.toolId
    && left.workAtomIds.length === right.workAtomIds.length
    && left.workAtomIds.every((id, index) => id === right.workAtomIds[index]);
}
export function hasStalePromotionManifest(
  events: readonly PromotionLedgerEvent[],
  target: CapabilityTarget,
  manifestRef: string,
): boolean {
  return events.some((event) => event.outcome === 'applied' && event.action === 'stale'
    && samePromotionTarget(event.target, target) && event.manifestRef === manifestRef);
}
function parseLines(source: string, secret: string): readonly PromotionLedgerEvent[] {
  const events: PromotionLedgerEvent[] = [];
  let previous: string = PROMOTION_GENESIS;
  for (const [index, line] of source.split('\n').filter((value) => value.length > 0).entries()) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new PromotionLedgerUnavailableError(); }
    let event: PromotionLedgerEvent;
    try { event = parsePromotionLedgerEvent(raw); }
    catch { throw new PromotionLedgerUnavailableError(); }
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
    private readonly authority?: LocalWriteAuthority,
  ) {}

  static async initialize(
    path: string, ledgerSecret: string, checkpointSecret: string,
    faults: PromotionLedgerFaults = {}, injectedAuthority?: LocalWriteAuthority,
  ): Promise<FilePromotionLedger> {
    assertPromotionSecrets(ledgerSecret, checkpointSecret);
    const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
      injectedAuthority, injectedAuthority?.projectId ?? '', 'capability_evidence_promotion', dirname(path),
    ));
    await initializePromotionStore(path, checkpointSecret, authority);
    const ledger = new FilePromotionLedger(path, ledgerSecret, checkpointSecret, faults, authority);
    assertPromotionStoreFiles(path);
    ledger.read();
    return ledger;
  }

  static open(
    path: string, ledgerSecret: string | undefined, checkpointSecret: string | undefined,
    injectedAuthority?: LocalWriteAuthority,
  ): FilePromotionLedger {
    if (ledgerSecret === undefined || checkpointSecret === undefined) throw new PromotionLedgerUnavailableError();
    assertPromotionSecrets(ledgerSecret, checkpointSecret);
    assertPromotionStoreFiles(path);
    return new FilePromotionLedger(path, ledgerSecret, checkpointSecret, {}, injectedAuthority);
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

  async append(input: PromotionLedgerEventInput): Promise<PromotionLedgerEvent> {
    const authority = requireLocalWriteAuthority(this.authority, expectedLocalWriteScope(
      this.authority, this.authority?.projectId ?? '', 'capability_evidence_promotion', dirname(this.path),
    ));
    return authority.fence.write(authority, {
      operation: 'capability-promotion.append', targetPaths: [this.path, promotionCheckpointPath(this.path)],
    }, () => withDirLock(`${this.path}.lock`, () => {
      const events = this.readVerified();
      const priorApplied = [...events].reverse().find((event) => event.outcome === 'applied'
        && samePromotionTarget(event.target, input.target));
      if (input.outcome === 'applied' && priorApplied !== undefined && priorApplied.toMaturity !== input.fromMaturity) {
        throw new PromotionLedgerStaleStateError();
      }
      if (input.outcome === 'applied' && input.action === 'promote'
        && hasStalePromotionManifest(events, input.target, input.manifestRef)) {
        throw new PromotionLedgerStaleEvidenceError();
      }
      const previous = events.at(-1)?.hash ?? PROMOTION_GENESIS;
      const unsigned = parseUnsignedPromotionLedgerEvent({ ...input, seq: events.length, prevHash: previous });
      const event = parsePromotionLedgerEvent({ ...unsigned, hash: eventHash(this.ledgerSecret, unsigned) });
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
    }));
  }

  async reconcile(): Promise<readonly PromotionLedgerEvent[]> {
    const authority = requireLocalWriteAuthority(this.authority, expectedLocalWriteScope(
      this.authority, this.authority?.projectId ?? '', 'capability_evidence_promotion', dirname(this.path),
    ));
    return authority.fence.write(authority, {
      operation: 'capability-promotion.reconcile', targetPaths: [this.path, promotionCheckpointPath(this.path)],
    }, () => withDirLock(`${this.path}.lock`, () => {
      const events = this.readLedger();
      const hashes = events.map(({ hash }) => hash);
      assertCheckpointPrefix(readPromotionCheckpoint(this.path, this.checkpointSecret), hashes);
      writePromotionCheckpoint(
        promotionCheckpointPath(this.path), this.checkpointSecret, events.length, hashes.at(-1) ?? PROMOTION_GENESIS,
      );
      return this.readVerified();
    }));
  }
  verify(): { readonly ok: boolean } {
    try { this.read(); return { ok: true }; }
    catch (error) {
      if (error instanceof PromotionLedgerUnavailableError) return { ok: false };
      throw error;
    }
  }
}
