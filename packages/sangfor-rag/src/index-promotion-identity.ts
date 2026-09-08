import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPromotionJson } from './index-promotion-evaluator.js';
import { HnswIndexIdentitySchema, type HnswIndexIdentity } from './index-promotion-types.js';
import type { PgvectorSqlExecutor } from './pgvector-types.js';

export const PROMOTED_HNSW_INDEX_NAME = 'BlroRagEmbedding_embedding_hnsw_idx' as const;
const IdentityRowSchema = z.object({
  oid: z.string(),
  relfilenode: z.string(),
  definition: z.string(),
  name: z.string(),
  tableName: z.string(),
  operatorClass: z.string(),
  valid: z.boolean(),
  ready: z.boolean(),
}).strict();

export async function readHnswIndexIdentity(
  transaction: PgvectorSqlExecutor,
  indexName: string,
): Promise<HnswIndexIdentity | null> {
  const rows = z.array(IdentityRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
    SELECT i.oid::text AS "oid",i.relfilenode::text AS "relfilenode",pg_get_indexdef(i.oid) AS "definition",
      i.relname AS "name",t.relname AS "tableName",opc.opcname AS "operatorClass",
      x.indisvalid AS "valid",x.indisready AS "ready"
    FROM pg_class i
    JOIN pg_namespace n ON n.oid=i.relnamespace AND n.nspname=current_schema()
    JOIN pg_index x ON x.indexrelid=i.oid
    JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_am a ON a.oid=i.relam AND a.amname='hnsw'
    JOIN pg_opclass opc ON opc.oid=x.indclass[0]
    WHERE i.relname=$1`, indexName));
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row) return null;
  const { definition, ...identity } = row;
  const parsed = HnswIndexIdentitySchema.safeParse({
    ...identity,
    definitionDigest: createHash('sha256').update(definition).digest('hex'),
  });
  return parsed.success ? parsed.data : null;
}

export function hnswIndexIdentityDigest(identity: HnswIndexIdentity): string {
  return createHash('sha256').update(canonicalPromotionJson(identity)).digest('hex');
}

export function sameHnswIndexIdentity(left: HnswIndexIdentity | null, right: HnswIndexIdentity): boolean {
  return left !== null && canonicalPromotionJson(left) === canonicalPromotionJson(right);
}
