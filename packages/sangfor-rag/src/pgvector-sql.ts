export const ACTIVE_COHORT_SQL = `
SELECT "id","backend","model","dimensions"
FROM "BlroRagEmbeddingCohort"
WHERE "tenantId"=$1 AND "projectId"=$2 AND "active"=true
ORDER BY "indexEpoch" DESC
FOR SHARE`;

export const SEARCH_SQL = `
WITH candidates AS MATERIALIZED (
  SELECT e."tenantId",e."projectId",e."chunkId",(e."embedding" <=> $8::vector) AS "distance"
  FROM "BlroRagEmbedding" e
  WHERE e."tenantId"=$1 AND e."projectId"=$2 AND e."cohortId"=$4
    AND (cardinality(e."aclActorIds")=0 OR $3=ANY(e."aclActorIds"))
    AND ($5::text IS NULL OR e."product"=$5)
    AND ($6::text IS NULL OR e."version"=$6)
    AND ($7::text IS NULL OR e."sourceType"=$7)
    AND ($9::text IS NULL OR e."trustLevel"=$9)
  ORDER BY e."embedding" <=> $8::vector
  LIMIT 1000
)
SELECT c."id",c."text",c."title",c."sourceRef",candidate."distance"
FROM candidates candidate
JOIN "BlroRagAuthoritativeChunk" c
  ON c."tenantId"=candidate."tenantId" AND c."projectId"=candidate."projectId" AND c."id"=candidate."chunkId"
ORDER BY candidate."distance"::real,c."id"
LIMIT $10`;

export const EXPLAIN_HNSW_SQL = `EXPLAIN (FORMAT TEXT, COSTS OFF) ${SEARCH_SQL}`;
export const REBUILD_HNSW_SQL = `REINDEX INDEX "BlroRagEmbedding_embedding_hnsw_idx"`;

export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
