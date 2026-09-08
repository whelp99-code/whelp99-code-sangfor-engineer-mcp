import { parseRuntimeJson } from '../../shared/src/runtime-schema.js';
import { auditLedgerLineRuntimeSchema } from '../../sangfor-hci-client/src/runtime-boundaries.js';
import type { LedgerLine } from './change-run-report.js';

export function parseBoundaryEvidenceLedgerLineV1(source: string): LedgerLine {
  return parseRuntimeJson(source, {
    schema: auditLedgerLineRuntimeSchema,
    schemaName: 'evidence.change-run-ledger-line.v1',
    policy: 'INDETERMINATE',
  });
}
