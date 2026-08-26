import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from '@sangfor/shared';
import { parseStoredIagApplyResult, type IagApplyResult } from './result.js';
import { IagCheckpointStore } from './store-checkpoint.js';
import { IagIndeterminateSealStore } from './store-seal.js';
import {
  canonicalOrchestratorValue,
  IAG_ORCHESTRATOR_GENESIS,
  IagLedgerSerializer,
  type IagLedgerSnapshot,
  type IagOrchestratorEvent,
} from './store-serialization.js';
import {
  IagOrchestratorStoreIndeterminateError,
  IagOrchestratorStoreUnavailableError,
} from './store-errors.js';
import {
  isIagTerminalState,
  isIagTransitionAllowed,
  type IagOrchestratorState,
} from './state.js';

export type { IagOrchestratorEvent } from './store-serialization.js';
export { IagOrchestratorStoreIndeterminateError, IagOrchestratorStoreUnavailableError } from './store-errors.js';
export type IagRunRecord = {
  readonly runId: string; readonly requestDigest: string;
  readonly events: readonly IagOrchestratorEvent[]; readonly terminal?: IagApplyResult;
};
export type IagRunClaim =
  | { readonly kind: 'FRESH' }
  | { readonly kind: 'ACTIVE' }
  | { readonly kind: 'UNCERTAIN'; readonly mutationAttempted: boolean }
  | { readonly kind: 'REPLAY'; readonly result: IagApplyResult }
  | { readonly kind: 'CONFLICT' };
export type IagTerminalCommit =
  | { readonly kind: 'COMMITTED'; readonly result: IagApplyResult }
  | { readonly kind: 'UNCERTAIN' };
export type IagStoreFaults = {
  readonly afterEventDurable?: (state: IagOrchestratorState) => void;
  readonly afterCheckpointDurable?: (state: IagOrchestratorState) => void;
  readonly beforeSealDurable?: () => void;
};
type IagStoreConfig = {
  readonly path: string; readonly ledgerSecret: string; readonly checkpointSecret: string;
  readonly faults: IagStoreFaults; readonly now: () => Date;
};
export type IagAppendInput = {
  readonly runId: string; readonly requestDigest: string;
  readonly state: IagOrchestratorState; readonly payload?: unknown;
};

export class FileIagOrchestratorStore {
  private readonly serializer: IagLedgerSerializer;
  private readonly checkpoint: IagCheckpointStore;
  private readonly seals: IagIndeterminateSealStore;

  private readonly path: string;
  private readonly faults: IagStoreFaults;

  private constructor(config: IagStoreConfig) {
    this.path = config.path;
    this.faults = config.faults;
    this.serializer = new IagLedgerSerializer(config.path, config.ledgerSecret, config.now);
    this.checkpoint = new IagCheckpointStore(config.path, config.checkpointSecret);
    this.seals = new IagIndeterminateSealStore(
      config.path, config.checkpointSecret, config.faults.beforeSealDurable,
    );
  }

  static initialize(input: {
    readonly ledgerPath: string; readonly ledgerSecret: string;
    readonly checkpointSecret: string; readonly faults?: IagStoreFaults; readonly now?: () => Date;
  }): FileIagOrchestratorStore {
    if (input.ledgerSecret.length < 32 || input.checkpointSecret.length < 32
      || input.ledgerSecret === input.checkpointSecret) throw new IagOrchestratorStoreUnavailableError();
    const checkpoint = new IagCheckpointStore(input.ledgerPath, input.checkpointSecret);
    if (existsSync(input.ledgerPath) !== existsSync(checkpoint.path)) throw new IagOrchestratorStoreUnavailableError();
    mkdirSync(dirname(input.ledgerPath), { recursive: true });
    if (!existsSync(input.ledgerPath)) {
      writeFileSync(input.ledgerPath, '', { mode: 0o600, flag: 'wx' });
      checkpoint.write(0, IAG_ORCHESTRATOR_GENESIS);
    }
    const store = new FileIagOrchestratorStore({
      path: input.ledgerPath, ledgerSecret: input.ledgerSecret,
      checkpointSecret: input.checkpointSecret, faults: input.faults ?? {},
      now: input.now ?? (() => new Date()),
    });
    const seals = store.seals.read();
    try {
      store.snapshot();
    } catch (error) {
      if (!(error instanceof IagOrchestratorStoreUnavailableError) || seals.length === 0) throw error;
    }
    return store;
  }

  private snapshot(): IagLedgerSnapshot {
    const checkpoint = this.checkpoint.read();
    return this.serializer.readCheckpointed(checkpoint.eventCount, checkpoint.lastHash);
  }
  private appendUnlocked(input: IagAppendInput): void {
    const { runId, requestDigest, state } = input;
    const snapshot = this.snapshot();
    if (snapshot.tail.kind !== 'NONE') throw new IagOrchestratorStoreUnavailableError();
    const events = snapshot.committed;
    const runEvents = events.filter((event) => event.runId === runId);
    const prior = runEvents.at(-1);
    if (prior !== undefined && !isIagTransitionAllowed(prior.state, state)) throw new IagOrchestratorStoreUnavailableError();
    if (prior === undefined && state !== 'RECEIVED') throw new IagOrchestratorStoreUnavailableError();
    if (runEvents.some((event) => isIagTerminalState(event.state))) throw new IagOrchestratorStoreUnavailableError();
    const event = this.serializer.create({ events, runId, requestDigest, state, payload: input.payload ?? {} });
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.path, 'a', 0o600);
      appendFileSync(descriptor, `${JSON.stringify(event)}\n`); fsyncSync(descriptor); closeSync(descriptor);
      descriptor = undefined; this.faults.afterEventDurable?.(state);
      this.checkpoint.write(events.length + 1, event.hash);
      this.faults.afterCheckpointDurable?.(state);
    } catch {
      if (descriptor !== undefined) closeSync(descriptor);
      throw new IagOrchestratorStoreIndeterminateError();
    }
  }

  claim(runId: string, requestDigest: string): IagRunClaim {
    return withDirLock(`${this.path}.lock`, () => {
      const sealed = this.seals.find(runId);
      if (sealed !== undefined) return sealed.requestDigest === requestDigest
        ? { kind: 'REPLAY', result: sealed.result } : { kind: 'CONFLICT' };
      const snapshot = this.snapshot();
      const events = snapshot.committed.filter((event) => event.runId === runId);
      if (events.some((event) => event.requestDigest !== requestDigest)) return { kind: 'CONFLICT' };
      const terminal = [...events].reverse().find((event) => isIagTerminalState(event.state));
      if (terminal !== undefined) return { kind: 'REPLAY', result: parseStoredIagApplyResult(terminal.payload) };
      const tailForRun = snapshot.tail.events.some((event) => event.runId === runId);
      if (tailForRun || (snapshot.tail.kind === 'CORRUPT' && events.length > 0)) {
        const lastState = events.at(-1)?.state;
        return { kind: 'UNCERTAIN', mutationAttempted: lastState === 'DISPATCHING' || lastState === 'VERIFYING' };
      }
      if (snapshot.tail.kind !== 'NONE') throw new IagOrchestratorStoreUnavailableError();
      if (events.length > 0) return { kind: 'ACTIVE' };
      this.appendUnlocked({ runId, requestDigest, state: 'RECEIVED', payload: { requestDigest } });
      return { kind: 'FRESH' };
    });
  }

  append(input: IagAppendInput): void {
    withDirLock(`${this.path}.lock`, () => this.appendUnlocked(input));
  }
  terminal(runId: string, requestDigest: string, result: IagApplyResult): void {
    this.append({ runId, requestDigest, state: result.outcome, payload: result });
  }
  resolveTerminal(runId: string, requestDigest: string, result: IagApplyResult): IagTerminalCommit {
    return withDirLock(`${this.path}.lock`, () => {
      const sealed = this.seals.find(runId);
      if (sealed !== undefined) return { kind: 'COMMITTED', result: sealed.result };
      const snapshot = this.snapshot();
      const terminal = [...snapshot.committed].reverse().find((event) => event.runId === runId && isIagTerminalState(event.state));
      if (terminal === undefined) return { kind: 'UNCERTAIN' };
      const committed = parseStoredIagApplyResult(terminal.payload);
      if (terminal.requestDigest !== requestDigest
        || canonicalOrchestratorValue(committed) !== canonicalOrchestratorValue(result)) {
        throw new IagOrchestratorStoreUnavailableError();
      }
      return { kind: 'COMMITTED', result: committed };
    });
  }
  sealIndeterminate(runId: string, requestDigest: string, result: IagApplyResult): void {
    withDirLock(`${this.path}.lock`, () => this.seals.seal({ runId, requestDigest, result }));
  }
  read(runId: string): IagRunRecord {
    const sealed = withDirLock(`${this.path}.lock`, () => this.seals.find(runId));
    if (sealed !== undefined) return { runId, requestDigest: sealed.requestDigest, events: [], terminal: sealed.result };
    const events = withDirLock(`${this.path}.lock`, () => this.snapshot().committed.filter((event) => event.runId === runId));
    if (events.length === 0) throw new IagOrchestratorStoreUnavailableError();
    const terminal = [...events].reverse().find((event) => isIagTerminalState(event.state));
    return { runId, requestDigest: events[0]?.requestDigest ?? '', events,
      ...(terminal === undefined ? {} : { terminal: parseStoredIagApplyResult(terminal.payload) }) };
  }
}
