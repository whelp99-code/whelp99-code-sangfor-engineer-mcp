import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlExecutor } from '../authority-store-contracts.js';
import { AuthorityCutoverError } from './errors.js';
import { canonicalJson, canonicalRecordSet, parseCutoverRecord } from './records.js';
import type { CutoverRecord } from './types.js';

export const stableTargetId = (aggregate: string, key: string): string =>
  `cutover-${createHash('sha256').update(`${aggregate}\0${key}`).digest('hex')}`;

export function recordEnvelope(record: CutoverRecord): string {
  return JSON.stringify({ cutoverRecord: record });
}

const envelopeSchema = z.object({ cutoverRecord: z.unknown() }).strict();
export function parseEnvelope(input: unknown): CutoverRecord {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_TARGET_INVALID', [], { cause: parsed.error });
  return parseCutoverRecord(parsed.data.cutoverRecord);
}

export async function insertExactPayloadRecord(tx:SqlExecutor,table:string,input:{id:string;tenantId:string;projectId:string;kind:string;record:CutoverRecord}):Promise<void>{
  const rows=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;kind:string;payload:unknown}>>(`SELECT "tenantId","projectId","kind","payload" FROM "${table}" WHERE "id"=$1`,input.id);const found=rows[0];
  if(found){if(found.tenantId!==input.tenantId||found.projectId!==input.projectId||found.kind!==input.kind||canonicalRecordSet([parseEnvelope(found.payload)]).digest!==canonicalRecordSet([input.record]).digest)throw new AuthorityCutoverError('TARGET_KEY_CONFLICT');return;}
  await tx.$executeRawUnsafe(`INSERT INTO "${table}" ("id","tenantId","projectId","kind","payload") VALUES ($1,$2,$3,$4,$5::jsonb)`,input.id,input.tenantId,input.projectId,input.kind,recordEnvelope(input.record));
}

export async function setProjectScope(tx: SqlExecutor, projectId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
}

export async function assertCleanupAllowed(tx: SqlExecutor, projectId: string, aggregate: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, projectId, aggregate);
  const rows = await tx.$queryRawUnsafe<Array<{ state: string }>>(
    `SELECT "state" FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`,
    projectId, aggregate,
  );
  if (!rows[0] || !['LOCAL_PRIMARY', 'BACKFILLING', 'SHADOW_READING'].includes(rows[0].state)) {
    throw new AuthorityCutoverError('CUTOVER_ROLLBACK_REFUSED');
  }
}

export async function checkpointRecords(
  tx: SqlExecutor,
  input: { readonly projectId: string; readonly aggregate: string; readonly highWaterMark: string; readonly records: readonly CutoverRecord[] },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `DELETE FROM "BlroAuthorityCutoverStaging" WHERE "projectId"=$1 AND "aggregate"=$2`,
    input.projectId, input.aggregate,
  );
  for (const record of input.records) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "BlroAuthorityCutoverStaging" ("projectId","aggregate","recordKey","highWaterMark","record","recordDigest")
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      input.projectId, input.aggregate, record.key, input.highWaterMark,
      JSON.stringify(record), createHash('sha256').update(canonicalJson(record)).digest('hex'),
    );
  }
}
