import { createHmac } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from '@sangfor/shared';
import { z } from 'zod';
import {
  canonicalOrchestratorValue,
  IAG_ORCHESTRATOR_GENESIS,
  orchestratorHashSchema,
} from './store-serialization.js';
import { IagOrchestratorStoreUnavailableError } from './store-errors.js';

const checkpointSchema = z.object({
  version: z.literal(1), eventCount: z.number().int().nonnegative(),
  lastHash: z.union([z.literal(IAG_ORCHESTRATOR_GENESIS), orchestratorHashSchema]),
  hmac: orchestratorHashSchema,
}).strict();
export type IagCheckpoint = z.infer<typeof checkpointSchema>;

export class IagCheckpointStore {
  readonly path: string;

  constructor(ledgerPath: string, private readonly secret: string) {
    this.path = `${ledgerPath}.head.json`;
  }

  private value(eventCount: number, lastHash: string): IagCheckpoint {
    return checkpointSchema.parse({
      version: 1, eventCount, lastHash,
      hmac: createHmac('sha256', this.secret).update(`${eventCount}\n${lastHash}`).digest('hex'),
    });
  }

  write(eventCount: number, lastHash: string): void {
    writeFileAtomicSync(this.path, JSON.stringify(this.value(eventCount, lastHash)));
  }

  read(): IagCheckpoint {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new IagOrchestratorStoreUnavailableError();
      const checkpoint = checkpointSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (canonicalOrchestratorValue(checkpoint)
        !== canonicalOrchestratorValue(this.value(checkpoint.eventCount, checkpoint.lastHash))) {
        throw new IagOrchestratorStoreUnavailableError();
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof IagOrchestratorStoreUnavailableError) throw error;
      throw new IagOrchestratorStoreUnavailableError();
    }
  }
}
