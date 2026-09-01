import { z } from 'zod';
import { runtimeJsonValueSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { LedgerLine } from './audit-ledger.js';

const hashSchema = z.string().min(1).max(512);

export const auditLedgerLineRuntimeSchema: RuntimeCodec<LedgerLine> = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string().min(1).max(128),
  runId: z.string().min(1).max(512),
  kind: z.enum(['request', 'response', 'state', 'verdict']),
  payload: runtimeJsonValueSchema,
  prevHash: hashSchema,
  hash: hashSchema,
  keyed: z.boolean(),
}).strict();

export function parseBoundaryHciAuditLineV1(source: string): LedgerLine {
  return parseRuntimeJson(source, {
    schema: auditLedgerLineRuntimeSchema,
    schemaName: 'hci-client.audit-ledger-line.v1',
    policy: 'INDETERMINATE',
  });
}
