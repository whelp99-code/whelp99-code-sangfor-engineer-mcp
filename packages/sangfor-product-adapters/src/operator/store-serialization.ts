import { createHmac } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { IAG_ORCHESTRATOR_STATES, type IagOrchestratorState } from './state.js';
import { IagOrchestratorStoreUnavailableError } from './store-errors.js';

export const IAG_ORCHESTRATOR_GENESIS = 'IAG_ORCHESTRATOR_GENESIS';
export const orchestratorHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const orchestratorEventSchema = z.object({
  version: z.literal(1), seq: z.number().int().nonnegative(), at: z.string().datetime(),
  runId: orchestratorHashSchema, requestDigest: orchestratorHashSchema,
  state: z.enum(IAG_ORCHESTRATOR_STATES), payload: z.unknown(),
  prevHash: z.union([z.literal(IAG_ORCHESTRATOR_GENESIS), orchestratorHashSchema]),
  hash: orchestratorHashSchema,
}).strict();
export type IagOrchestratorEvent = z.infer<typeof orchestratorEventSchema>;
export type IagLedgerTail =
  | { readonly kind: 'NONE'; readonly events: readonly [] }
  | { readonly kind: 'VALID'; readonly events: readonly IagOrchestratorEvent[] }
  | { readonly kind: 'CORRUPT'; readonly events: readonly IagOrchestratorEvent[] };
export type IagLedgerSnapshot = {
  readonly committed: readonly IagOrchestratorEvent[];
  readonly tail: IagLedgerTail;
};

export function canonicalOrchestratorValue(value: unknown): string {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOrchestratorValue).join(',')}]`;
  if (typeof value !== 'object') throw new IagOrchestratorStoreUnavailableError();
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalOrchestratorValue(child)}`).join(',')}}`;
}

export function maskOrchestratorPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskOrchestratorPayload);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key,
      /password|secret|token|authorization|cookie|nonce/iu.test(key) && typeof child === 'string'
        ? '***' : maskOrchestratorPayload(child)]),
  );
  return value;
}

export class IagLedgerSerializer {
  constructor(
    private readonly path: string,
    private readonly secret: string,
    private readonly now: () => Date,
  ) {}

  eventHash(event: Omit<IagOrchestratorEvent, 'hash'>): string {
    return createHmac('sha256', this.secret)
      .update(`sangfor.iag.orchestrator.v1\n${canonicalOrchestratorValue(event)}`).digest('hex');
  }

  readCheckpointed(eventCount: number, checkpointHash: string): IagLedgerSnapshot {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new IagOrchestratorStoreUnavailableError();
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      if (lines.length < eventCount) throw new IagOrchestratorStoreUnavailableError();
      const committed: IagOrchestratorEvent[] = [];
      let previous = IAG_ORCHESTRATOR_GENESIS;
      for (let index = 0; index < eventCount; index += 1) {
        const line = lines[index];
        if (line === undefined) throw new IagOrchestratorStoreUnavailableError();
        const event = orchestratorEventSchema.parse(JSON.parse(line));
        const { hash, ...unsigned } = event;
        if (event.seq !== index || event.prevHash !== previous || hash !== this.eventHash(unsigned)) {
          throw new IagOrchestratorStoreUnavailableError();
        }
        committed.push(event); previous = hash;
      }
      if (previous !== checkpointHash) throw new IagOrchestratorStoreUnavailableError();
      const tail: IagOrchestratorEvent[] = [];
      for (let index = eventCount; index < lines.length; index += 1) {
        try {
          const event = orchestratorEventSchema.parse(JSON.parse(lines[index] ?? ''));
          const { hash, ...unsigned } = event;
          if (event.seq !== index || event.prevHash !== previous || hash !== this.eventHash(unsigned)) {
            return { committed, tail: { kind: 'CORRUPT', events: tail } };
          }
          tail.push(event); previous = hash;
        } catch (error) {
          if (error instanceof Error) return { committed, tail: { kind: 'CORRUPT', events: tail } };
          throw error;
        }
      }
      return tail.length === 0
        ? { committed, tail: { kind: 'NONE', events: [] } }
        : { committed, tail: { kind: 'VALID', events: tail } };
    } catch (error) {
      if (error instanceof IagOrchestratorStoreUnavailableError) throw error;
      throw new IagOrchestratorStoreUnavailableError();
    }
  }

  create(input: {
    readonly events: readonly IagOrchestratorEvent[];
    readonly runId: string;
    readonly requestDigest: string;
    readonly state: IagOrchestratorState;
    readonly payload: unknown;
  }): IagOrchestratorEvent {
    const unsigned = {
      version: 1 as const, seq: input.events.length, at: this.now().toISOString(),
      runId: input.runId, requestDigest: input.requestDigest, state: input.state,
      payload: maskOrchestratorPayload(input.payload),
      prevHash: input.events.at(-1)?.hash ?? IAG_ORCHESTRATOR_GENESIS,
    };
    return orchestratorEventSchema.parse({ ...unsigned, hash: this.eventHash(unsigned) });
  }
}
