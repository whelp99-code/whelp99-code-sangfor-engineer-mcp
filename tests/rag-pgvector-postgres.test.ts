import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBenchmarkCorpus } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import { CandidateSearchUnavailableError, IndexPromotionRouter } from '../packages/sangfor-rag/src/index-promotion-router.js';
import { IndexPromotionStore } from '../packages/sangfor-rag/src/index-promotion-store.js';
import type { PromotionSearchPort } from '../packages/sangfor-rag/src/index-promotion-types.js';
import {
  PgvectorRagStore,
  RagPgvectorRefusal,
  RagPgvectorUnavailableError,
} from '../packages/sangfor-rag/src/pgvector-store.js';
import {
  parsePgvectorCohort,
  parsePgvectorScope,
  parsePgvectorUpsert,
} from '../packages/sangfor-rag/src/pgvector-schema.js';
import { cleanupRagProjects, fixtureProjectIds } from './support/rag-postgres-corpus.js';
import { PGVECTOR_HASH_EMBEDDING_SPACE } from '../packages/sangfor-rag/src/pgvector-types.js';
import type { PgvectorDatabase, PgvectorSqlExecutor } from '../packages/sangfor-rag/src/pgvector-types.js';
import { embeddingSpaceId } from '../packages/sangfor-rag/src/embedding-space.js';
import { exercisePromotionHistory } from './support/rag-promotion-history-postgres.js';
import { createHnsw, promotionFixture } from './support/rag-promotion-postgres.js';

const profile = process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] === '1';
const databaseUrl = process.env['DATABASE_URL'];
if (profile && !databaseUrl) throw new TypeError('RAG_PGVECTOR_DATABASE_REQUIRED');

const suite = profile ? describe : describe.skip;
const scope = parsePgvectorScope({ tenantId: 'tenant-rag-pg', projectId: 'project-rag-pg', actorId: 'actor-rag-pg' });
const cohort = parsePgvectorCohort({ id: 'cohort-rag-pg', ...scope, indexEpoch: 33, backend: 'hash', model: 'hash', dimensions: 384, embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE });
const promotionAuthority = {
  actorId: scope.actorId,
  secret: 'rag-postgres-promotion-authority-secret-32-bytes',
} as const;
let promotionNonce = 0;
const fixtureCorpus = parseBenchmarkCorpus(JSON.parse(readFileSync('data/evals/rag/project-completeness-v1.json', 'utf8')));
const testProjectIds = [scope.projectId, ...fixtureProjectIds(fixtureCorpus)];
const chunk = (id: string, text: string, aclActorIds: readonly string[] = []) => parsePgvectorUpsert({
  ...scope, cohortId: cohort.id, id, product: 'HCI', version: '1.0', sourceType: 'manual',
  trustLevel: 'official', title: id, text, sourceRef: `synthetic/${id}.md`,
  contentHash: `sha256-${id}`, aclActorIds, embedding: hashEmbedding(text), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE,
});

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve: () => resolve?.() };
}

class ApplyLockObservedDatabase implements PgvectorDatabase {
  constructor(
    private readonly inner: PrismaClient,
    private readonly beforeLock: () => void,
    private readonly afterLock: () => void,
  ) {}

  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number> {
    return this.inner.$executeRawUnsafe(query, ...values);
  }

  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
    return this.inner.$queryRawUnsafe<T>(query, ...values);
  }

  $transaction<T>(operation: (transaction: PgvectorSqlExecutor) => Promise<T>, options?: { readonly isolationLevel?: 'ReadCommitted' | 'Serializable' }): Promise<T> {
    return this.inner.$transaction((transaction) => operation({
      $executeRawUnsafe: async (query, ...values) => {
        if (!query.includes('advisory_xact_lock')) return transaction.$executeRawUnsafe(query, ...values);
        this.beforeLock();
        const result = await transaction.$executeRawUnsafe(query, ...values);
        this.afterLock();
        return result;
      },
      $queryRawUnsafe: (query, ...values) => transaction.$queryRawUnsafe(query, ...values),
    }), options);
  }
}

async function currentPromotion(promotion: IndexPromotionStore) {
  promotionNonce += 1;
  return promotionFixture({
    promotion, scope, authority: promotionAuthority,
    nonce: `postgres-promotion-${process.pid}-${String(promotionNonce).padStart(8, '0')}`,
  });
}

suite('PostgreSQL-native pgvector RAG', () => {
  let owner: PrismaClient;
  let database: PrismaClient;
  let store: PgvectorRagStore;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: process.env['BLRO_OWNER_DATABASE_URL'] ?? databaseUrl } } });
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    store = new PgvectorRagStore(database);
    await cleanupRagProjects(owner, testProjectIds);
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2) ON CONFLICT ("id") DO NOTHING`, scope.tenantId, 'RAG tenant');
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3) ON CONFLICT ("id") DO NOTHING`, scope.projectId, scope.tenantId, 'RAG project');
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,'service') ON CONFLICT ("id") DO NOTHING`, scope.actorId, scope.tenantId, 'RAG actor');
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ('role-rag-pg',$1,'rag-writer',ARRAY['rag:read','rag:write']) ON CONFLICT ("id") DO NOTHING`, scope.tenantId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ('membership-rag-pg',$1,$2,$3,'role-rag-pg') ON CONFLICT ("projectId","actorId") DO NOTHING`, scope.tenantId, scope.projectId, scope.actorId);
    });
  });

  afterAll(async () => {
    try {
      if (owner) await cleanupRagProjects(owner, testProjectIds);
    } finally {
      await Promise.all([database?.$disconnect(), owner?.$disconnect()]);
    }
  });

  it('creates one active cohort and transactionally persists, searches, updates, and deletes chunks', async () => {
    await store.promoteCohort(cohort);
    await store.replace({ scope, cohortId: cohort.id, chunks: [chunk('chunk-a', 'storage mtu oracle'), chunk('chunk-b', 'unrelated dns')] });
    const exact = await store.searchExact({ scope, query: hashEmbedding('storage mtu oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: { product: 'HCI', version: '1.0', sourceType: 'manual', trustLevel: 'official' }, limit: 2 });
    expect(exact.map((hit) => hit.id)).toEqual(['chunk-a', 'chunk-b']);
    await store.upsert(chunk('chunk-a', 'updated storage mtu oracle'));
    await store.delete({ scope, chunkId: chunk('chunk-b', 'unrelated dns').id });
    expect((await store.searchExact({ scope, query: hashEmbedding('updated storage mtu oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 5 })).map((hit) => hit.id)).toEqual(['chunk-a']);
  });

  it('applies ACL in SQL and proves the HNSW plan uses the vector index', async () => {
    await store.upsert(chunk('chunk-acl', 'private acl oracle', ['actor-other']));
    await store.upsert(parsePgvectorUpsert({ ...chunk('chunk-filtered', 'filtered oracle'), version: '2.0', sourceType: 'wiki', trustLevel: 'draft' }));
    const hits = await store.searchHnsw({ scope, query: hashEmbedding('private acl oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 5 });
    expect(hits.map((hit) => hit.id)).not.toContain('chunk-acl');
    const filtered = await store.searchExact({ scope, query: hashEmbedding('filtered oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: { version: '1.0', sourceType: 'manual', trustLevel: 'official' }, limit: 10 });
    expect(filtered.map((hit) => hit.id)).not.toContain('chunk-filtered');
    expect(await store.explainHnsw({ scope, query: hashEmbedding('updated storage mtu oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 5 })).toContain('BlroRagEmbedding_embedding_hnsw_idx');
  });

  it('refuses invalid vectors and ambiguous cohorts without fallback', async () => {
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [Number.NaN] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [Number.POSITIVE_INFINITY] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [1] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorCohort({ ...cohort, id: 'cohort-wrong', dimensions: 12 })).toThrow(RagPgvectorRefusal);
  });

  it('binds vectors and queries to the complete immutable embedding space', async () => {
    const changedSpace = { ...PGVECTOR_HASH_EMBEDDING_SPACE, revision: 'sha256-buckets-v2' };
    const before = await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      return transaction.$queryRawUnsafe<Array<{ embedding: string }>>(`
        SELECT "embedding"::text AS "embedding" FROM "BlroRagEmbedding"
        WHERE "tenantId"=$1 AND "projectId"=$2 AND "cohortId"=$3 AND "chunkId"='chunk-a'`,
      scope.tenantId, scope.projectId, cohort.id);
    });
    await expect(store.promoteCohort({ ...cohort, embeddingSpace: changedSpace }))
      .rejects.toMatchObject({ code: 'RAG_PGVECTOR_COHORT_IDENTITY_IMMUTABLE' });
    await expect(store.promoteCohort({ ...cohort, indexEpoch: cohort.indexEpoch + 1 }))
      .rejects.toMatchObject({ code: 'RAG_PGVECTOR_COHORT_IDENTITY_IMMUTABLE' });
    await expect(store.upsert({ ...chunk('space-mismatch', 'space mismatch'), embeddingSpace: changedSpace }))
      .rejects.toMatchObject({ code: 'RAG_PGVECTOR_EMBEDDING_SPACE_MISMATCH' });
    await expect(store.searchExact({ scope, query: hashEmbedding('oracle'), embeddingSpace: changedSpace, filters: {}, limit: 1 }))
      .rejects.toMatchObject({ code: 'RAG_PGVECTOR_QUERY_EMBEDDING_SPACE_MISMATCH' });
    await expect(store.searchExact({ scope, query: hashEmbedding('updated storage mtu oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 1 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'chunk-a' })]));
    const after = await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      return transaction.$queryRawUnsafe<Array<{ revision: string; indexEpoch: number; embedding: string }>>(`
        SELECT c."embeddingSpace"->>'revision' AS "revision",c."indexEpoch",e."embedding"::text AS "embedding"
        FROM "BlroRagEmbeddingCohort" c JOIN "BlroRagEmbedding" e
          ON e."tenantId"=c."tenantId" AND e."projectId"=c."projectId" AND e."cohortId"=c."id"
        WHERE c."tenantId"=$1 AND c."projectId"=$2 AND c."id"=$3 AND e."chunkId"='chunk-a'`,
      scope.tenantId, scope.projectId, cohort.id);
    });
    expect(after).toEqual([{ revision: PGVECTOR_HASH_EMBEDDING_SPACE.revision, indexEpoch: cohort.indexEpoch, embedding: before[0]?.embedding }]);
  });

  it('rolls back replacement atomically on a duplicate id and leaves local index bytes unchanged', async () => {
    const localPath = 'data/evals/rag/project-completeness-v1.json';
    const before = readFileSync(localPath);
    await expect(store.replace({ scope, cohortId: cohort.id, chunks: [chunk('duplicate', 'first'), chunk('duplicate', 'second')] })).rejects.toBeInstanceOf(RagPgvectorRefusal);
    expect(readFileSync(localPath)).toEqual(before);
    expect((await store.searchExact({ scope, query: hashEmbedding('updated storage mtu oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 5 })).map((hit) => hit.id)).toContain('chunk-a');
  });

  it('persists across a new store instance and serializes concurrent updates', async () => {
    await Promise.all([
      store.upsert(chunk('chunk-concurrent', 'concurrent update alpha')),
      store.upsert(chunk('chunk-concurrent', 'concurrent update beta')),
    ]);
    const restarted = new PgvectorRagStore(database);
    const hits = await restarted.searchExact({ scope, query: hashEmbedding('concurrent update'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 100 });
    expect(hits.filter((hit) => hit.id === 'chunk-concurrent')).toHaveLength(1);
  });

  it('retains scoped promotion nonce history across overwrite, restart, concurrency, and corruption', async () => {
    const nonceA = `history-a-${process.pid}-00000001`;
    const nonceB = `history-b-${process.pid}-00000002`;
    const result = await exercisePromotionHistory({
      database, owner, scope, authority: promotionAuthority, nonceA, nonceB,
    });
    expect(result).toEqual({
      oldReplayCode: 'PROMOTION_EVIDENCE_REPLAY',
      concurrentCodes: ['PROMOTION_EVIDENCE_REPLAY', 'PROMOTION_EVIDENCE_REPLAY'],
      restartedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      baseHistory: [nonceA, nonceB],
      crossScopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      crossHistory: [nonceA],
      corruptReason: 'PROMOTION_REPORT_INVALID', missingReason: 'PROMOTION_REPORT_INVALID',
      historyUpdateRefused: true, historyDeleteRefused: true, promotionDeleteCount: 1,
      replayAfterMutationCode: 'PROMOTION_EVIDENCE_REPLAY',
    });
  });

  it('binds one HNSW identity through normal search, missing preflight, drop race, and same-name replacement', async () => {
    const promotion = new IndexPromotionStore(database, { promotionAuthority });
    const query = { scope, query: hashEmbedding('oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 1 };
    const normal = await new IndexPromotionRouter(promotion).search(query, { backend: 'auto', now: new Date() });
    expect(normal).toMatchObject({ backend: 'hnsw', diagnostics: { reason: 'PROMOTION_VALID' } });

    await owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
    const missing = await new IndexPromotionRouter(promotion).search(query, { backend: 'auto', now: new Date() });
    expect(missing).toMatchObject({ backend: 'exact', diagnostics: { reason: 'CANDIDATE_PREFLIGHT_UNAVAILABLE' } });
    await createHnsw(owner);
    let promotionInput = await currentPromotion(promotion);
    await promotion.apply({ scope, evidence: promotionInput.evidence, now: promotionInput.now, reason: 'drop race test' });

    const calls = { exact: 0, candidate: 0 };
    const observed: PromotionSearchPort = {
      loadPromotion: (input) => promotion.loadPromotion(input),
      readCurrentState: (input) => promotion.readCurrentState(input),
      preflightCandidate: (input, name) => promotion.preflightCandidate(input, name),
      searchExact: async (input) => { calls.exact += 1; return promotion.searchExact(input); },
      searchCandidate: async (input, identity, report, now) => { calls.candidate += 1; return promotion.searchCandidate(input, identity, report, now); },
    };
    try {
      await expect(new IndexPromotionRouter(observed).search(query, {
        backend: 'auto', now: new Date(),
        beforeCandidateDispatch: () => owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`).then(() => undefined),
      })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
      expect(calls).toEqual({ exact: 0, candidate: 1 });
    } finally {
      if (!await promotion.preflightCandidate(scope, promotionInput.report.indexName)) await createHnsw(owner);
    }

    promotionInput = await currentPromotion(promotion);
    await promotion.apply({ scope, evidence: promotionInput.evidence, now: promotionInput.now, reason: 'same-name replacement test' });
    const before = await promotion.preflightCandidate(scope, promotionInput.report.indexName);
    calls.exact = 0;
    calls.candidate = 0;
    await expect(new IndexPromotionRouter(observed).search(query, {
      backend: 'auto', now: new Date(),
      beforeCandidateDispatch: async () => {
        await owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
        await createHnsw(owner);
      },
    })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
    const after = await promotion.preflightCandidate(scope, promotionInput.report.indexName);
    expect(calls).toEqual({ exact: 0, candidate: 1 });
    expect(before?.oid).not.toBe(after?.oid);
    expect(before?.relfilenode).not.toBe(after?.relfilenode);

    if (!after) throw new TypeError('RAG_HNSW_POSTCHECK_FIXTURE_MISSING');
    promotionInput = await currentPromotion(promotion);
    await promotion.apply({ scope, evidence: promotionInput.evidence, now: promotionInput.now, reason: 'postcheck test' });
    let identityProbes = 0;
    let afterQueryCalls = 0;
    const changed = { ...after, relfilenode: String(Number(after.relfilenode) + 1) };
    const postcheck = new IndexPromotionStore(database, {
      promotionAuthority,
      candidateIdentityProbe: async () => { identityProbes += 1; return identityProbes === 1 ? after : changed; },
      afterCandidateQuery: async () => { afterQueryCalls += 1; },
    });
    await expect(postcheck.searchCandidate(query, after, promotionInput.report, promotionInput.now)).rejects.toMatchObject({ code: 'RAG_HNSW_POSTCHECK_IDENTITY_CHANGED' });
    expect(afterQueryCalls).toBe(1);
  });

  it.each(['cohort', 'corpus', 'demotion'] as const)('refuses %s changes after routing validation without returning candidate hits', async (change) => {
    await store.promoteCohort(cohort);
    const promotion = new IndexPromotionStore(database, { promotionAuthority });
    const current = await currentPromotion(promotion);
    await promotion.apply({ scope, evidence: current.evidence, now: current.now, reason: 'dispatch race regression' });
    const query = { scope, query: hashEmbedding('oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 1 };
    await expect(new IndexPromotionRouter(promotion).search(query, {
      backend: 'auto', now: current.now,
      beforeCandidateDispatch: async () => {
        if (change === 'cohort') await store.promoteCohort(parsePgvectorCohort({ ...cohort, id: 'dispatch-race-cohort', indexEpoch: 91 }));
        else if (change === 'corpus') await store.upsert(chunk('dispatch-race-chunk', 'changed oracle'));
        else await promotion.demote(scope, 'dispatch race demotion');
      },
    })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
    await store.promoteCohort(cohort);
  });

  it('re-reads current cohort after waiting for the apply lock and refuses stale evidence', async () => {
    await store.promoteCohort(cohort);
    const authority = new IndexPromotionStore(database, { promotionAuthority });
    const stale = await currentPromotion(authority);
    const holderReady = deferred();
    const changeCohort = deferred();
    const applyReachedLock = deferred();
    let applyAcquiredLock = false;
    const replacementId = 'cohort-rag-pg-replacement';

    const holder = owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, scope.tenantId, scope.projectId);
      holderReady.resolve();
      await changeCohort.promise;
      await transaction.$executeRawUnsafe(`UPDATE "BlroRagEmbeddingCohort" SET "active"=false WHERE "tenantId"=$1 AND "projectId"=$2 AND "active"=true`, scope.tenantId, scope.projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagEmbeddingCohort"
        ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","embeddingSpace","embeddingSpaceDigest","active")
        VALUES ($1,$2,$3,$4,'hash','hash',384,$5::jsonb,$6,true)`, replacementId, scope.tenantId,
      scope.projectId, cohort.indexEpoch + 1, JSON.stringify(PGVECTOR_HASH_EMBEDDING_SPACE), embeddingSpaceId(PGVECTOR_HASH_EMBEDDING_SPACE));
    });
    await holderReady.promise;

    const observed = new IndexPromotionStore(new ApplyLockObservedDatabase(
      database, () => applyReachedLock.resolve(), () => { applyAcquiredLock = true; },
    ), { promotionAuthority });
    const applying = observed.apply({ scope, evidence: stale.evidence, now: stale.now, reason: 'stale lock race' });
    await applyReachedLock.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(applyAcquiredLock).toBe(false);
    changeCohort.resolve();
    await holder;
    await expect(applying).rejects.toMatchObject({ code: 'PROMOTION_COHORT_MISMATCH' });
    expect(applyAcquiredLock).toBe(true);
  });

  it('returns typed unavailable for database outage and never an empty success', async () => {
    const unavailableDatabase = new PrismaClient({ datasources: { db: { url: 'postgresql://127.0.0.1:1/unavailable?connect_timeout=1' } } });
    const unavailable = new PgvectorRagStore(unavailableDatabase);
    await expect(unavailable.searchExact({ scope, query: hashEmbedding('oracle'), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: {}, limit: 1 })).rejects.toBeInstanceOf(RagPgvectorUnavailableError);
    await unavailableDatabase.$disconnect();
  });
});
