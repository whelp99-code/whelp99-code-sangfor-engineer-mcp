import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from '@sangfor/shared';
import { z } from 'zod';
import { parseStoredIagApplyResult, type IagApplyResult } from './result.js';
import { canonicalOrchestratorValue, orchestratorHashSchema } from './store-serialization.js';
import {
  IagOrchestratorStoreIndeterminateError,
  IagOrchestratorStoreUnavailableError,
} from './store-errors.js';

const storedRecordSchema = z.object({
  runId: orchestratorHashSchema, requestDigest: orchestratorHashSchema, result: z.unknown(),
}).strict();
const sealFileSchema = z.object({
  version: z.literal(1), records: z.array(storedRecordSchema), hmac: orchestratorHashSchema,
}).strict();
type IagSealRecord = {
  readonly runId: string;
  readonly requestDigest: string;
  readonly result: IagApplyResult;
};

export class IagIndeterminateSealStore {
  private readonly path: string;

  constructor(
    ledgerPath: string,
    private readonly secret: string,
    private readonly beforeSealDurable?: () => void,
  ) {
    this.path = `${ledgerPath}.indeterminate.json`;
  }

  private hmac(records: readonly unknown[]): string {
    return createHmac('sha256', this.secret)
      .update(`sangfor.iag.indeterminate-seal.v1\n${canonicalOrchestratorValue(records)}`).digest('hex');
  }

  read(): readonly IagSealRecord[] {
    let source: string;
    try {
      source = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return [];
      throw new IagOrchestratorStoreUnavailableError();
    }
    try {
      const parsed = sealFileSchema.parse(JSON.parse(source));
      if (parsed.hmac !== this.hmac(parsed.records)) throw new IagOrchestratorStoreUnavailableError();
      return parsed.records.map((record) => ({
        runId: record.runId, requestDigest: record.requestDigest,
        result: parseStoredIagApplyResult(record.result),
      }));
    } catch (error) {
      if (error instanceof IagOrchestratorStoreUnavailableError) throw error;
      if (error instanceof Error) throw new IagOrchestratorStoreUnavailableError();
      throw error;
    }
  }

  find(runId: string): IagSealRecord | undefined {
    return this.read().find((record) => record.runId === runId);
  }

  seal(record: IagSealRecord): void {
    const records = this.read();
    const existing = records.find((candidate) => candidate.runId === record.runId);
    if (existing !== undefined) {
      if (canonicalOrchestratorValue(existing) !== canonicalOrchestratorValue(record)) {
        throw new IagOrchestratorStoreUnavailableError();
      }
      return;
    }
    try {
      this.beforeSealDurable?.();
      const next = [...records, record];
      writeFileAtomicSync(this.path, JSON.stringify({ version: 1, records: next, hmac: this.hmac(next) }));
    } catch (error) {
      if (error instanceof IagOrchestratorStoreUnavailableError) throw error;
      if (error instanceof Error) throw new IagOrchestratorStoreIndeterminateError();
      throw error;
    }
  }
}
