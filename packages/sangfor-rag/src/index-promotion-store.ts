import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPromotionJson, evaluateIndexPromotion, parseIndexPromotionReport } from './index-promotion-evaluator.js';
import {
  hnswIndexIdentityDigest,
  readHnswIndexIdentity,
  sameHnswIndexIdentity,
} from './index-promotion-identity.js';
import type { HnswIndexIdentity, IndexPromotionReport, PromotionCurrentState, PromotionSearchPort } from './index-promotion-types.js';
import { IndexPromotionReportSchema, PromotionCurrentStateSchema } from './index-promotion-types.js';
import { PgvectorRagStore } from './pgvector-store.js';
import { ACTIVE_COHORT_SQL, EXPLAIN_HNSW_SQL, SEARCH_SQL, vectorLiteral } from './pgvector-sql.js';
import { RagPgvectorRefusal, RagPgvectorUnavailableError, parsePgvectorScope } from './pgvector-schema.js';
import { PgvectorHitRowSchema, type PgvectorDatabase, type PgvectorScope, type PgvectorSearch, type PgvectorSqlExecutor } from './pgvector-types.js';

const PromotionRowSchema = z.object({ report: z.unknown(), reportCanonical: z.string(), reportDigest: z.string() }).strict();
const ActiveRowSchema = z.object({ id: z.string(), backend: z.string(), model: z.string(), dimensions: z.number().int() }).strict();
const PlanRowSchema = z.object({ 'QUERY PLAN': z.string() }).strict();
const CorpusRowSchema = z.object({ id: z.string(), contentHash: z.string(), embedding: z.string() }).strict();
const CurrentRowSchema = z.object({
  cohortId: z.string(), indexEpoch: z.number().int(), extensionName: z.string(), extensionVersion: z.string(),
  candidateRowCount: z.union([z.number(), z.bigint(), z.string()]).transform(Number).pipe(z.number().int().nonnegative()),
}).strict();

type CandidateIdentityProbe = (transaction: PgvectorSqlExecutor, indexName: string) => Promise<HnswIndexIdentity | null>;
type IndexPromotionStoreOptions = {
  readonly candidateIdentityProbe?: CandidateIdentityProbe;
  readonly afterCandidateQuery?: () => Promise<void>;
};

type ApplyInput = {
  readonly scope: PgvectorScope;
  readonly report: unknown;
  readonly now: Date;
  readonly reason: string;
};

async function setScope(transaction: PgvectorSqlExecutor, scope: PgvectorScope): Promise<void> {
  await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
}

export class IndexPromotionStore implements PromotionSearchPort {
  private readonly rag: PgvectorRagStore;

  constructor(
    private readonly database: PgvectorDatabase,
    private readonly options: IndexPromotionStoreOptions = {},
  ) {
    this.rag = new PgvectorRagStore(database);
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RagPgvectorRefusal || error instanceof RagPgvectorUnavailableError) throw error;
      throw new RagPgvectorUnavailableError('RAG_INDEX_PROMOTION_UNAVAILABLE', { cause: error });
    }
  }

  async loadPromotion(scopeRaw: PgvectorScope): Promise<unknown | null> {
    const scope = parsePgvectorScope(scopeRaw);
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      const rows = z.array(PromotionRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
        SELECT "report","reportCanonical","reportDigest" FROM "BlroRagIndexPromotion"
        WHERE "tenantId"=$1 AND "projectId"=$2 AND "state"='promoted'
        ORDER BY "promotedAt" DESC`, scope.tenantId, scope.projectId));
      if (rows.length > 1) throw new RagPgvectorRefusal('RAG_INDEX_PROMOTION_AMBIGUOUS', scope.projectId);
      const row = rows[0];
      if (!row) return null;
      const report = IndexPromotionReportSchema.safeParse(row.report);
      if (!report.success || row.reportCanonical !== canonicalPromotionJson(report.data) || row.reportDigest !== report.data.reportDigest) {
        return { schemaVersion: 'persisted-promotion-envelope-tampered' };
      }
      return report.data;
    }));
  }

  async readCurrentState(scopeRaw: PgvectorScope): Promise<PromotionCurrentState> {
    const scope = parsePgvectorScope(scopeRaw);
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      const identity = await readHnswIndexIdentity(transaction, 'BlroRagEmbedding_embedding_hnsw_idx');
      if (!identity) throw new RagPgvectorRefusal('RAG_INDEX_PROMOTION_INDEX_UNAVAILABLE', scope.projectId);
      const metadata = z.array(CurrentRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
        SELECT c."id" AS "cohortId",c."indexEpoch",e.extname AS "extensionName",e.extversion AS "extensionVersion",
          (SELECT count(*) FROM "BlroRagEmbedding" r WHERE r."tenantId"=$1 AND r."projectId"=$2 AND r."cohortId"=c."id") AS "candidateRowCount"
        FROM "BlroRagEmbeddingCohort" c
        JOIN pg_extension e ON e.extname='vector'
        WHERE c."tenantId"=$1 AND c."projectId"=$2 AND c."active"=true`, scope.tenantId, scope.projectId));
      if (metadata.length !== 1) throw new RagPgvectorRefusal('RAG_INDEX_PROMOTION_CURRENT_STATE_AMBIGUOUS', `${metadata.length}`);
      const row = metadata[0];
      if (!row) throw new RagPgvectorRefusal('RAG_INDEX_PROMOTION_CURRENT_STATE_AMBIGUOUS', 'missing');
      const corpus = z.array(CorpusRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
        SELECT c."id",c."contentHash",e."embedding"::text AS "embedding"
        FROM "BlroRagAuthoritativeChunk" c JOIN "BlroRagEmbedding" e
          ON e."tenantId"=c."tenantId" AND e."projectId"=c."projectId" AND e."chunkId"=c."id"
        WHERE e."tenantId"=$1 AND e."projectId"=$2 AND e."cohortId"=$3 ORDER BY c."id"`,
      scope.tenantId, scope.projectId, row.cohortId));
      return PromotionCurrentStateSchema.parse({
        tenantId: scope.tenantId, projectId: scope.projectId, cohortId: row.cohortId, indexEpoch: row.indexEpoch,
        corpusDigest: createHash('sha256').update(canonicalPromotionJson(corpus)).digest('hex'),
        extensionName: row.extensionName, extensionVersion: row.extensionVersion, indexName: identity.name,
        indexIdentity: hnswIndexIdentityDigest(identity),
        candidateRowCount: row.candidateRowCount,
      });
    }));
  }

  async apply(raw: ApplyInput): Promise<IndexPromotionReport> {
    const scope = parsePgvectorScope(raw.scope);
    const report = parseIndexPromotionReport(raw.report);
    const current = await this.readCurrentState(scope);
    const evaluation = evaluateIndexPromotion(report, current, raw.now);
    if (!evaluation.eligible) throw new RagPgvectorRefusal(evaluation.reason, report.reportDigest);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),0)`, scope.projectId);
      await transaction.$executeRawUnsafe(`UPDATE "BlroRagIndexPromotion" SET "state"='demoted',"demotedAt"=$3,"updatedAt"=$3,"reason"='superseded' WHERE "tenantId"=$1 AND "projectId"=$2 AND "state"='promoted'`, scope.tenantId, scope.projectId, raw.now);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "BlroRagIndexPromotion" ("tenantId","projectId","cohortId","indexEpoch","report","reportCanonical","reportDigest","state","reason","promotedAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'promoted',$8,$9,$9)
        ON CONFLICT ("tenantId","projectId","cohortId","indexEpoch") DO UPDATE SET
          "report"=EXCLUDED."report","reportCanonical"=EXCLUDED."reportCanonical","reportDigest"=EXCLUDED."reportDigest",
          "state"='promoted',"reason"=EXCLUDED."reason","promotedAt"=EXCLUDED."promotedAt","demotedAt"=NULL,"updatedAt"=EXCLUDED."updatedAt"`,
      scope.tenantId, scope.projectId, report.cohortId, report.indexEpoch, canonicalPromotionJson(report),
      canonicalPromotionJson(report), report.reportDigest, raw.reason, raw.now);
    }, { isolationLevel: 'Serializable' }));
    return report;
  }

  async demote(scopeRaw: PgvectorScope, reason: string): Promise<void> {
    const scope = parsePgvectorScope(scopeRaw);
    await this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),0)`, scope.projectId);
      await transaction.$executeRawUnsafe(`UPDATE "BlroRagIndexPromotion" SET "state"='demoted',"reason"=$3,"demotedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE "tenantId"=$1 AND "projectId"=$2 AND "state"='promoted'`, scope.tenantId, scope.projectId, reason);
    }, { isolationLevel: 'Serializable' }));
  }

  async preflightCandidate(scopeRaw: PgvectorScope, indexName: string): Promise<HnswIndexIdentity | null> {
    const scope = parsePgvectorScope(scopeRaw);
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, scope);
      return readHnswIndexIdentity(transaction, indexName);
    }));
  }

  searchExact(input: PgvectorSearch): Promise<unknown> { return this.rag.searchExact(input); }

  async searchCandidate(input: PgvectorSearch, expectedIdentity: HnswIndexIdentity): Promise<unknown> {
    return this.execute(() => this.database.$transaction(async (transaction) => {
      await setScope(transaction, input.scope);
      if (!sameHnswIndexIdentity(await this.candidateIdentity(transaction, expectedIdentity.name), expectedIdentity)) {
        throw new RagPgvectorRefusal('RAG_HNSW_IDENTITY_CHANGED', expectedIdentity.oid);
      }
      await transaction.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
      await transaction.$executeRawUnsafe('SET LOCAL enable_sort=off');
      await transaction.$executeRawUnsafe('SET LOCAL hnsw.ef_search=1000');
      await transaction.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan='strict_order'`);
      const activeRows = z.array(ActiveRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(ACTIVE_COHORT_SQL, input.scope.tenantId, input.scope.projectId));
      const active = activeRows[0];
      if (activeRows.length !== 1 || !active) throw new RagPgvectorRefusal('RAG_PGVECTOR_ACTIVE_COHORT_AMBIGUOUS', `${activeRows.length}`);
      const values = this.searchValues(input, active.id);
      const planRows = z.array(PlanRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(EXPLAIN_HNSW_SQL, ...values));
      const plan = planRows.map((row) => row['QUERY PLAN']).join('\n');
      if (!plan.includes(`Index Scan using "${expectedIdentity.name}"`)) {
        throw new RagPgvectorRefusal('RAG_HNSW_PLAN_IDENTITY_MISMATCH', expectedIdentity.name);
      }
      const hits = z.array(PgvectorHitRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(SEARCH_SQL, ...values));
      await this.options.afterCandidateQuery?.();
      // EXPLAIN and SELECT acquire relation locks held until this transaction ends, so DROP/REINDEX
      // cannot complete during execution. This fresh statement still detects invalidation or replacement.
      if (!sameHnswIndexIdentity(await this.candidateIdentity(transaction, expectedIdentity.name), expectedIdentity)) {
        throw new RagPgvectorRefusal('RAG_HNSW_POSTCHECK_IDENTITY_CHANGED', expectedIdentity.oid);
      }
      return hits;
    }, { isolationLevel: 'ReadCommitted' }));
  }

  private candidateIdentity(transaction: PgvectorSqlExecutor, indexName: string): Promise<HnswIndexIdentity | null> {
    return this.options.candidateIdentityProbe?.(transaction, indexName) ?? readHnswIndexIdentity(transaction, indexName);
  }

  private searchValues(input: PgvectorSearch, cohortId: string): readonly unknown[] {
    return [input.scope.tenantId, input.scope.projectId, input.scope.actorId, cohortId,
      input.filters.product ?? null, input.filters.version ?? null, input.filters.sourceType ?? null,
      vectorLiteral(input.query), input.filters.trustLevel ?? null, input.limit];
  }
}
