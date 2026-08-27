import { z } from 'zod';
import {
  ACTIVE_COHORT_SQL,
  EXPLAIN_HNSW_SQL,
  REBUILD_HNSW_SQL,
  SEARCH_SQL,
  vectorLiteral,
} from './pgvector-sql.js';
import {
  RagPgvectorRefusal,
  RagPgvectorUnavailableError,
  parsePgvectorCohort,
  parsePgvectorScope,
  parsePgvectorSearch,
  parsePgvectorUpsert,
} from './pgvector-schema.js';
import {
  PgvectorHitRowSchema,
  type PgvectorCohort,
  type PgvectorDatabase,
  type PgvectorHit,
  type PgvectorScope,
  type PgvectorSearch,
  type PgvectorSqlExecutor,
  type PgvectorUpsert,
} from './pgvector-types.js';

export { RagPgvectorRefusal, RagPgvectorUnavailableError } from './pgvector-schema.js';

const ActiveRowSchema = z.object({
  id: z.string(), backend: z.string(), model: z.string(), dimensions: z.number().int(),
}).strict();
const PlanRowSchema = z.object({ 'QUERY PLAN': z.string() }).strict();

type ReplaceInput = {
  readonly scope: PgvectorScope;
  readonly cohortId: PgvectorUpsert['cohortId'];
  readonly chunks: readonly PgvectorUpsert[];
};
type DeleteInput = { readonly scope: PgvectorScope; readonly chunkId: PgvectorUpsert['id'] };

async function setScope(transaction: PgvectorSqlExecutor, scope: PgvectorScope): Promise<void> {
  await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
}

async function requireActive(transaction: PgvectorSqlExecutor, scope: PgvectorScope): Promise<z.infer<typeof ActiveRowSchema>> {
  const rows = z.array(ActiveRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(ACTIVE_COHORT_SQL, scope.tenantId, scope.projectId));
  if (rows.length !== 1) throw new RagPgvectorRefusal('RAG_PGVECTOR_ACTIVE_COHORT_AMBIGUOUS', `received ${rows.length} active cohorts`);
  const active = rows[0];
  if (!active) throw new RagPgvectorRefusal('RAG_PGVECTOR_ACTIVE_COHORT_AMBIGUOUS', 'active cohort disappeared');
  return active;
}

async function writeChunk(transaction: PgvectorSqlExecutor, input: PgvectorUpsert): Promise<void> {
  const active = await requireActive(transaction, input);
  if (active.id !== input.cohortId || active.dimensions !== input.embedding.length) {
    throw new RagPgvectorRefusal('RAG_PGVECTOR_COHORT_MISMATCH', input.id);
  }
  await transaction.$executeRawUnsafe(`
    INSERT INTO "BlroRagAuthoritativeChunk"
      ("id","tenantId","projectId","actorId","product","version","sourceType","trustLevel","title","text","sourceRef","contentHash","aclActorIds")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT ("tenantId","projectId","id") DO UPDATE SET
      "actorId"=EXCLUDED."actorId","product"=EXCLUDED."product","version"=EXCLUDED."version",
      "sourceType"=EXCLUDED."sourceType","trustLevel"=EXCLUDED."trustLevel","title"=EXCLUDED."title",
      "text"=EXCLUDED."text","sourceRef"=EXCLUDED."sourceRef","contentHash"=EXCLUDED."contentHash",
      "aclActorIds"=EXCLUDED."aclActorIds","updatedAt"=CURRENT_TIMESTAMP`,
    input.id, input.tenantId, input.projectId, input.actorId, input.product, input.version,
    input.sourceType, input.trustLevel, input.title, input.text, input.sourceRef, input.contentHash,
    input.aclActorIds,
  );
  await transaction.$executeRawUnsafe(`
    INSERT INTO "BlroRagEmbedding"
      ("tenantId","projectId","chunkId","cohortId","product","version","sourceType","trustLevel","aclActorIds","embedding")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)
    ON CONFLICT ("tenantId","projectId","chunkId","cohortId") DO UPDATE SET
      "product"=EXCLUDED."product","version"=EXCLUDED."version","sourceType"=EXCLUDED."sourceType",
      "trustLevel"=EXCLUDED."trustLevel","aclActorIds"=EXCLUDED."aclActorIds",
      "embedding"=EXCLUDED."embedding","updatedAt"=CURRENT_TIMESTAMP`,
    input.tenantId, input.projectId, input.id, input.cohortId, input.product, input.version,
    input.sourceType, input.trustLevel, input.aclActorIds, vectorLiteral(input.embedding),
  );
}

export class PgvectorRagStore {
  constructor(private readonly database: PgvectorDatabase) {}

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RagPgvectorRefusal || error instanceof RagPgvectorUnavailableError) throw error;
      throw new RagPgvectorUnavailableError('RAG_PGVECTOR_UNAVAILABLE', { cause: error });
    }
  }

  async promoteCohort(raw: PgvectorCohort): Promise<void> {
    const input = parsePgvectorCohort(raw);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, input);
      await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),$2::int)`, input.projectId, input.indexEpoch);
      await transaction.$executeRawUnsafe(`UPDATE "BlroRagEmbeddingCohort" SET "active"=false WHERE "tenantId"=$1 AND "projectId"=$2 AND "active"=true`, input.tenantId, input.projectId);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "BlroRagEmbeddingCohort"
          ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","active")
        VALUES ($1,$2,$3,$4,$5,$6,$7,true)
        ON CONFLICT ("tenantId","projectId","id") DO UPDATE SET
          "indexEpoch"=EXCLUDED."indexEpoch","backend"=EXCLUDED."backend","model"=EXCLUDED."model",
          "dimensions"=EXCLUDED."dimensions","active"=true`,
        input.id, input.tenantId, input.projectId, input.indexEpoch, input.backend, input.model, input.dimensions,
      );
    }, { isolationLevel: 'Serializable' }));
  }

  async upsert(raw: PgvectorUpsert): Promise<void> {
    const input = parsePgvectorUpsert(raw);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, input);
      await writeChunk(transaction, input);
    }));
  }

  async replace(raw: ReplaceInput): Promise<void> {
    const scope = parsePgvectorScope(raw.scope);
    const chunks = raw.chunks.map(parsePgvectorUpsert);
    if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) {
      throw new RagPgvectorRefusal('RAG_PGVECTOR_DUPLICATE_CHUNK_ID', scope.projectId);
    }
    if (chunks.some((chunk) => chunk.tenantId !== scope.tenantId || chunk.projectId !== scope.projectId || chunk.cohortId !== raw.cohortId)) {
      throw new RagPgvectorRefusal('RAG_PGVECTOR_REPLACE_SCOPE_MISMATCH', scope.projectId);
    }
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      const active = await requireActive(transaction, scope);
      if (active.id !== raw.cohortId) throw new RagPgvectorRefusal('RAG_PGVECTOR_COHORT_MISMATCH', active.id);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagAuthoritativeChunk" WHERE "tenantId"=$1 AND "projectId"=$2`, scope.tenantId, scope.projectId);
      for (const chunk of chunks) await writeChunk(transaction, chunk);
    }, { isolationLevel: 'Serializable' }));
  }

  async delete(raw: DeleteInput): Promise<void> {
    const scope = parsePgvectorScope(raw.scope);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagAuthoritativeChunk" WHERE "tenantId"=$1 AND "projectId"=$2 AND "id"=$3`, scope.tenantId, scope.projectId, raw.chunkId);
    }));
  }

  async searchExact(raw: PgvectorSearch): Promise<readonly PgvectorHit[]> {
    const input = parsePgvectorSearch(raw);
    return this.search(input, 'exact');
  }

  async searchHnsw(raw: PgvectorSearch): Promise<readonly PgvectorHit[]> {
    const input = parsePgvectorSearch(raw);
    return this.search(input, 'hnsw');
  }

  private async search(input: PgvectorSearch, mode: 'exact' | 'hnsw'): Promise<readonly PgvectorHit[]> {
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, input.scope);
      if (mode === 'exact') {
        await transaction.$executeRawUnsafe('SET LOCAL enable_indexscan=off');
        await transaction.$executeRawUnsafe('SET LOCAL enable_bitmapscan=off');
      } else {
        await transaction.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
        await transaction.$executeRawUnsafe('SET LOCAL enable_sort=off');
        await transaction.$executeRawUnsafe('SET LOCAL hnsw.ef_search=1000');
        await transaction.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan='strict_order'`);
      }
      const active = await requireActive(transaction, input.scope);
      const rows = await transaction.$queryRawUnsafe<unknown>(SEARCH_SQL, ...this.searchValues(input, active.id));
      return z.array(PgvectorHitRowSchema).parse(rows);
    }));
  }

  async explainHnsw(raw: PgvectorSearch): Promise<string> {
    const input = parsePgvectorSearch(raw);
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, input.scope);
      await transaction.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
      await transaction.$executeRawUnsafe('SET LOCAL enable_sort=off');
      await transaction.$executeRawUnsafe('SET LOCAL hnsw.ef_search=1000');
      await transaction.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan='strict_order'`);
      const active = await requireActive(transaction, input.scope);
      const rows = z.array(PlanRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(EXPLAIN_HNSW_SQL, ...this.searchValues(input, active.id)));
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    }));
  }

  async rebuildHnsw(scopeInput: PgvectorScope): Promise<void> {
    const scope = parsePgvectorScope(scopeInput);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      await requireActive(transaction, scope);
      await transaction.$executeRawUnsafe(REBUILD_HNSW_SQL);
    }));
  }

  private searchValues(input: PgvectorSearch, cohortId: string): readonly unknown[] {
    return [input.scope.tenantId, input.scope.projectId, input.scope.actorId, cohortId,
      input.filters.product ?? null, input.filters.version ?? null, input.filters.sourceType ?? null,
      vectorLiteral(input.query), input.filters.trustLevel ?? null, input.limit];
  }
}
