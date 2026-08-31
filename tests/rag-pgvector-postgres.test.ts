import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { growBenchmarkChunks } from '../packages/sangfor-rag/src/benchmark-growth.js';
import { parseBenchmarkCorpus } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { cosineSimilarity, hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import { sealIndexPromotionReport } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';
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

const profile = process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] === '1';
const databaseUrl = process.env['DATABASE_URL'];
if (profile && !databaseUrl) throw new TypeError('RAG_PGVECTOR_DATABASE_REQUIRED');

const suite = profile ? describe : describe.skip;
const scope = parsePgvectorScope({ tenantId: 'tenant-rag-pg', projectId: 'project-rag-pg', actorId: 'actor-rag-pg' });
const cohort = parsePgvectorCohort({ id: 'cohort-rag-pg', ...scope, indexEpoch: 33, backend: 'hash', model: 'hash-v1', dimensions: 384 });
function denseHashVector(text: string): readonly number[] {
  const values = hashEmbedding(text).map((value) => value + 0.01);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

const chunk = (id: string, text: string, aclActorIds: readonly string[] = []) => parsePgvectorUpsert({
  ...scope, cohortId: cohort.id, id, product: 'HCI', version: '1.0', sourceType: 'manual',
  trustLevel: 'official', title: id, text, sourceRef: `synthetic/${id}.md`,
  contentHash: `sha256-${id}`, aclActorIds, embedding: hashEmbedding(text),
});

async function currentPromotion(promotion: IndexPromotionStore) {
  const state = await promotion.readCurrentState(scope);
  const now = new Date();
  return { now, report: sealIndexPromotionReport({
    schemaVersion: 'rag.index-promotion/1', ...state, exactResultDigest: 'a'.repeat(64),
    candidateResultDigest: 'b'.repeat(64), measuredAt: now.toISOString(), maxAgeSeconds: 3600,
    recallAtK: 0.99, exactP95Ms: 200, candidateP95Ms: 150, recoveryRate: 1, updateRate: 1,
    scopeIsolationProof: true, candidateRowCount: state.candidateRowCount,
  }) };
}

async function createHnsw(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`CREATE INDEX "BlroRagEmbedding_embedding_hnsw_idx" ON "BlroRagEmbedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64)`);
}

suite('PostgreSQL-native pgvector RAG', () => {
  let owner: PrismaClient;
  let database: PrismaClient;
  let store: PgvectorRagStore;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: process.env['BLRO_OWNER_DATABASE_URL'] ?? databaseUrl } } });
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    store = new PgvectorRagStore(database);
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
    await database?.$disconnect();
    await owner?.$disconnect();
  });

  it('creates one active cohort and transactionally persists, searches, updates, and deletes chunks', async () => {
    await store.promoteCohort(cohort);
    await store.replace({ scope, cohortId: cohort.id, chunks: [chunk('chunk-a', 'storage mtu oracle'), chunk('chunk-b', 'unrelated dns')] });
    const exact = await store.searchExact({ scope, query: hashEmbedding('storage mtu oracle'), filters: { product: 'HCI', version: '1.0', sourceType: 'manual', trustLevel: 'official' }, limit: 2 });
    expect(exact.map((hit) => hit.id)).toEqual(['chunk-a', 'chunk-b']);
    await store.upsert(chunk('chunk-a', 'updated storage mtu oracle'));
    await store.delete({ scope, chunkId: chunk('chunk-b', 'unrelated dns').id });
    expect((await store.searchExact({ scope, query: hashEmbedding('updated storage mtu oracle'), filters: {}, limit: 5 })).map((hit) => hit.id)).toEqual(['chunk-a']);
  });

  it('applies ACL in SQL and proves the HNSW plan uses the vector index', async () => {
    await store.upsert(chunk('chunk-acl', 'private acl oracle', ['actor-other']));
    await store.upsert(parsePgvectorUpsert({ ...chunk('chunk-filtered', 'filtered oracle'), version: '2.0', sourceType: 'wiki', trustLevel: 'draft' }));
    const hits = await store.searchHnsw({ scope, query: hashEmbedding('private acl oracle'), filters: {}, limit: 5 });
    expect(hits.map((hit) => hit.id)).not.toContain('chunk-acl');
    const filtered = await store.searchExact({ scope, query: hashEmbedding('filtered oracle'), filters: { version: '1.0', sourceType: 'manual', trustLevel: 'official' }, limit: 10 });
    expect(filtered.map((hit) => hit.id)).not.toContain('chunk-filtered');
    expect(await store.explainHnsw({ scope, query: hashEmbedding('updated storage mtu oracle'), filters: {}, limit: 5 })).toContain('BlroRagEmbedding_embedding_hnsw_idx');
  });

  it('refuses invalid vectors and ambiguous cohorts without fallback', async () => {
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [Number.NaN] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [Number.POSITIVE_INFINITY] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorUpsert({ ...chunk('bad', 'bad'), embedding: [1] })).toThrow(RagPgvectorRefusal);
    expect(() => parsePgvectorCohort({ ...cohort, id: 'cohort-wrong', dimensions: 12 })).toThrow(RagPgvectorRefusal);
  });

  it('rolls back replacement atomically on a duplicate id and leaves local index bytes unchanged', async () => {
    const localPath = 'data/evals/rag/project-completeness-v1.json';
    const before = readFileSync(localPath);
    await expect(store.replace({ scope, cohortId: cohort.id, chunks: [chunk('duplicate', 'first'), chunk('duplicate', 'second')] })).rejects.toBeInstanceOf(RagPgvectorRefusal);
    expect(readFileSync(localPath)).toEqual(before);
    expect((await store.searchExact({ scope, query: hashEmbedding('updated storage mtu oracle'), filters: {}, limit: 5 })).map((hit) => hit.id)).toContain('chunk-a');
  });

  it('persists across a new store instance and serializes concurrent updates', async () => {
    await Promise.all([
      store.upsert(chunk('chunk-concurrent', 'concurrent update alpha')),
      store.upsert(chunk('chunk-concurrent', 'concurrent update beta')),
    ]);
    const restarted = new PgvectorRagStore(database);
    const hits = await restarted.searchExact({ scope, query: hashEmbedding('concurrent update'), filters: {}, limit: 100 });
    expect(hits.filter((hit) => hit.id === 'chunk-concurrent')).toHaveLength(1);
  });

  it('matches the scope-first exact oracle at 100% and reaches at least 0.99 HNSW recall on the deterministic 10x corpus', async () => {
    const corpusPath = 'data/evals/rag/project-completeness-v1.json';
    const corpusBytes = readFileSync(corpusPath);
    const corpus = parseBenchmarkCorpus(JSON.parse(corpusBytes.toString('utf8')));
    const grown = growBenchmarkChunks(corpus.chunks, 10).chunks;
    const rows = grown.map((entry) => parsePgvectorUpsert({
      ...scope, cohortId: cohort.id, id: entry.id, product: entry.product, version: entry.version,
      sourceType: entry.sourceType, trustLevel: entry.trustLevel, title: entry.title, text: entry.text,
      sourceRef: entry.filePath, contentHash: `todo32-${entry.id}`, aclActorIds: entry.aclActorIds,
      embedding: denseHashVector(entry.text),
    }));
    await store.replace({ scope, cohortId: cohort.id, chunks: rows });
    let exactRows = 0;
    let exactParityRows = 0;
    let hnswExpected = 0;
    let hnswRecovered = 0;
    const misses: string[] = [];
    for (const query of corpus.queries) {
      const search = { scope, query: denseHashVector(query.text), filters: query.filters, limit: query.limit };
      const exact = await store.searchExact(search);
      const hnsw = await store.searchHnsw(search);
      const candidates = rows.filter((row) =>
        (row.aclActorIds.length === 0 || row.aclActorIds.includes(scope.actorId))
        && (!query.filters.product || row.product === query.filters.product)
        && (!query.filters.version || row.version === query.filters.version)
        && (!query.filters.sourceType || row.sourceType === query.filters.sourceType)
        && (!query.filters.trustLevel || row.trustLevel === query.filters.trustLevel));
      const expectedExact = candidates
        .map((candidate) => ({
          id: candidate.id,
          distance: 1 - cosineSimilarity([...search.query], [...candidate.embedding]),
        }))
        .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
        .slice(0, query.limit);
      expect(exact.map((hit) => hit.id), query.id).toEqual(expectedExact.map((hit) => hit.id));
      for (const hit of exact) {
        const candidate = candidates.find((row) => row.id === hit.id);
        exactRows += 1;
        if (candidate && Math.abs(hit.distance - (1 - cosineSimilarity([...search.query], [...candidate.embedding]))) < 0.000_01) exactParityRows += 1;
      }
      const exactIds = new Set(exact.map((hit) => hit.id));
      hnswExpected += exactIds.size;
      const recovered = hnsw.filter((hit) => exactIds.has(hit.id)).length;
      hnswRecovered += recovered;
      if (recovered !== exactIds.size) misses.push(`${query.id}:${JSON.stringify(exact)}:${JSON.stringify(hnsw)}`);
    }
    expect(exactRows).toBeGreaterThan(0);
    expect(exactParityRows / exactRows).toBe(1);
    expect(hnswRecovered / hnswExpected, misses.join('\n')).toBeGreaterThanOrEqual(0.99);
    expect(readFileSync(corpusPath)).toEqual(corpusBytes);
  });

  it('persists a scoped promotion across restart and serializes concurrent promote and demote', async () => {
    const promotion = new IndexPromotionStore(database);
    const { report, now } = await currentPromotion(promotion);
    await Promise.all([
      promotion.apply({ scope, report, now, reason: 'postgres promotion test' }),
      promotion.demote(scope, 'concurrent postgres demotion test'),
    ]);
    await promotion.apply({ scope, report, now, reason: 'restart persistence test' });
    const restarted = new IndexPromotionStore(database);
    expect((await restarted.loadPromotion(scope))).toMatchObject({ reportDigest: report.reportDigest, projectId: scope.projectId });
    const promoted = await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      return transaction.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) AS count FROM "BlroRagIndexPromotion" WHERE "tenantId"=$1 AND "projectId"=$2 AND "state"='promoted'`, scope.tenantId, scope.projectId);
    });
    expect(Number(promoted[0]?.count)).toBe(1);
  });

  it('binds one HNSW identity through normal search, missing preflight, drop race, and same-name replacement', async () => {
    const promotion = new IndexPromotionStore(database);
    const query = { scope, query: hashEmbedding('oracle'), filters: {}, limit: 1 };
    const normal = await new IndexPromotionRouter(promotion).search(query, { backend: 'auto', now: new Date() });
    expect(normal).toMatchObject({ backend: 'hnsw', diagnostics: { reason: 'PROMOTION_VALID' } });

    await owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
    const missing = await new IndexPromotionRouter(promotion).search(query, { backend: 'auto', now: new Date() });
    expect(missing).toMatchObject({ backend: 'exact', diagnostics: { reason: 'CANDIDATE_PREFLIGHT_UNAVAILABLE' } });
    await createHnsw(owner);
    let { report, now } = await currentPromotion(promotion);
    await promotion.apply({ scope, report, now, reason: 'drop race test' });

    const calls = { exact: 0, candidate: 0 };
    const observed: PromotionSearchPort = {
      loadPromotion: (input) => promotion.loadPromotion(input),
      readCurrentState: (input) => promotion.readCurrentState(input),
      preflightCandidate: (input, name) => promotion.preflightCandidate(input, name),
      searchExact: async (input) => { calls.exact += 1; return promotion.searchExact(input); },
      searchCandidate: async (input, identity) => { calls.candidate += 1; return promotion.searchCandidate(input, identity); },
    };
    try {
      await expect(new IndexPromotionRouter(observed).search(query, {
        backend: 'auto', now: new Date(),
        beforeCandidateDispatch: () => owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`).then(() => undefined),
      })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
      expect(calls).toEqual({ exact: 0, candidate: 1 });
    } finally {
      if (!await promotion.preflightCandidate(scope, report.indexName)) await createHnsw(owner);
    }

    ({ report, now } = await currentPromotion(promotion));
    await promotion.apply({ scope, report, now, reason: 'same-name replacement test' });
    const before = await promotion.preflightCandidate(scope, report.indexName);
    calls.exact = 0;
    calls.candidate = 0;
    await expect(new IndexPromotionRouter(observed).search(query, {
      backend: 'auto', now: new Date(),
      beforeCandidateDispatch: async () => {
        await owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
        await createHnsw(owner);
      },
    })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
    const after = await promotion.preflightCandidate(scope, report.indexName);
    expect(calls).toEqual({ exact: 0, candidate: 1 });
    expect(before?.oid).not.toBe(after?.oid);
    expect(before?.relfilenode).not.toBe(after?.relfilenode);

    if (!after) throw new TypeError('RAG_HNSW_POSTCHECK_FIXTURE_MISSING');
    let identityProbes = 0;
    let afterQueryCalls = 0;
    const changed = { ...after, relfilenode: String(Number(after.relfilenode) + 1) };
    const postcheck = new IndexPromotionStore(database, {
      candidateIdentityProbe: async () => { identityProbes += 1; return identityProbes === 1 ? after : changed; },
      afterCandidateQuery: async () => { afterQueryCalls += 1; },
    });
    await expect(postcheck.searchCandidate(query, after)).rejects.toMatchObject({ code: 'RAG_HNSW_POSTCHECK_IDENTITY_CHANGED' });
    expect(afterQueryCalls).toBe(1);
  });

  it('returns typed unavailable for database outage and never an empty success', async () => {
    const unavailableDatabase = new PrismaClient({ datasources: { db: { url: 'postgresql://127.0.0.1:1/unavailable?connect_timeout=1' } } });
    const unavailable = new PgvectorRagStore(unavailableDatabase);
    await expect(unavailable.searchExact({ scope, query: hashEmbedding('oracle'), filters: {}, limit: 1 })).rejects.toBeInstanceOf(RagPgvectorUnavailableError);
    await unavailableDatabase.$disconnect();
  });
});
