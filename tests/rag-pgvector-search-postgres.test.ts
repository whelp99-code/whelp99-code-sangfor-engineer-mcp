import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { growBenchmarkChunks } from '../packages/sangfor-rag/src/benchmark-growth.js';
import { parseBenchmarkCorpus } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import { EXACT_SEARCH_SQL } from '../packages/sangfor-rag/src/pgvector-sql.js';
import { parsePgvectorScope } from '../packages/sangfor-rag/src/pgvector-schema.js';
import { PgvectorRagStore } from '../packages/sangfor-rag/src/pgvector-store.js';
import {
  buildScopeFirstCorpusFixture,
  cleanupRagProjects,
  exactParity,
  expectedExact,
  fixtureProjectIds,
  fixtureScope,
  rawExactSearch,
} from './support/rag-postgres-corpus.js';
import { createHnsw } from './support/rag-promotion-postgres.js';

const profile = process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] === '1';
const databaseUrl = process.env['DATABASE_URL'];
if (profile && !databaseUrl) throw new TypeError('RAG_PGVECTOR_DATABASE_REQUIRED');

const suite = profile ? describe : describe.skip;
const corpusPath = 'data/evals/rag/project-completeness-v1.json';
const corpusBytes = readFileSync(corpusPath);
const corpus = parseBenchmarkCorpus(JSON.parse(corpusBytes.toString('utf8')));
const projectIds = fixtureProjectIds(corpus);
const primarySourceScope = parsePgvectorScope({
  tenantId: 'tenant-alpha', projectId: 'project-alpha', actorId: 'actor-alpha',
});
const primaryScope = fixtureScope(primarySourceScope);

function denseHashVector(text: string): readonly number[] {
  const values = hashEmbedding(text).map((value) => value + 0.01);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

suite('PostgreSQL pgvector exact and HNSW gates', () => {
  let owner: PrismaClient;
  let database: PrismaClient;
  let store: PgvectorRagStore;

  beforeAll(() => {
    owner = new PrismaClient({ datasources: { db: { url: process.env['BLRO_OWNER_DATABASE_URL'] ?? databaseUrl } } });
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    store = new PgvectorRagStore(database);
  });

  beforeEach(async () => cleanupRagProjects(owner, projectIds));
  afterEach(async () => cleanupRagProjects(owner, projectIds));
  afterAll(async () => Promise.all([database?.$disconnect(), owner?.$disconnect()]));

  it('Given an authorized primary scope beyond 1000 rows, When exact search runs, Then raw SQL order and scope isolation remain exact', async () => {
    // Given: 60 deterministic copies are used only to cross the exact-search boundary.
    const rows = await buildScopeFirstCorpusFixture({
      owner, store, corpus, chunks: growBenchmarkChunks(corpus.chunks, 60).chunks, embedding: denseHashVector,
    });
    const primaryRows = rows.filter((row) =>
      row.tenantId === primaryScope.tenantId && row.projectId === primaryScope.projectId);
    const crossScopeBase = corpus.chunks.filter((row) =>
      row.tenantId !== primarySourceScope.tenantId || row.projectId !== primarySourceScope.projectId);

    // When: every corpus query is compared with independent raw SQL and the mathematical oracle.
    const parity: number[] = [];
    for (const query of corpus.queries) {
      const search = {
        scope: fixtureScope(parsePgvectorScope(query.scope)), query: denseHashVector(query.text),
        filters: query.filters, limit: query.limit,
      };
      const expected = expectedExact(rows, search);
      const raw = await rawExactSearch(owner, search);
      const exact = await store.searchExact(search);
      expect(raw.map((hit) => hit.id), query.id).toEqual(expected.map((hit) => hit.id));
      expect(exact.map((hit) => hit.id), query.id).toEqual(raw.map((hit) => hit.id));
      parity.push(exactParity(expected, exact));
    }
    const isolationQuery = corpus.queries.find((query) => query.id === 'q-scope-isolation');
    if (!isolationQuery) throw new TypeError('RAG_SCOPE_ISOLATION_QUERY_MISSING');
    const isolated = await store.searchExact({
      scope: primaryScope, query: denseHashVector(isolationQuery.text),
      filters: isolationQuery.filters, limit: isolationQuery.limit,
    });

    // Then: exact search sees the complete authorized scope, retains decoys, and leaks none.
    expect(primaryRows.length).toBeGreaterThan(1_000);
    expect(EXACT_SEARCH_SQL).not.toContain('LIMIT 1000');
    expect(parity.every((value) => value === 1)).toBe(true);
    expect(crossScopeBase.map((row) => row.id)).toEqual(['hci-cross-project', 'hci-cross-tenant']);
    expect(crossScopeBase.every((base) => rows.some((row) => row.id === base.id
      && row.tenantId === base.tenantId && row.projectId === fixtureScope(parsePgvectorScope({
        tenantId: base.tenantId, projectId: base.projectId, actorId: `rag-fixture-writer-${base.tenantId}`,
      })).projectId))).toBe(true);
    expect(isolated.map((hit) => hit.id)).toEqual(isolationQuery.expectedIds);
    expect(isolated.some((hit) => isolationQuery.forbiddenIds.includes(hit.id))).toBe(false);
    expect(readFileSync(corpusPath)).toEqual(corpusBytes);
  });

  it('Given the canonical deterministic 10x corpus and rebuilt index, When HNSW runs, Then recall, index use, and exact parity pass', async () => {
    // Given: Todo32/33's fixed 10x corpus is rebuilt independently of the exact stress gate.
    const canonicalPrimary = corpus.chunks.filter((chunk) =>
      chunk.tenantId === primarySourceScope.tenantId && chunk.projectId === primarySourceScope.projectId);
    const grown = growBenchmarkChunks(canonicalPrimary, 10).chunks;
    await buildScopeFirstCorpusFixture({ owner, store, corpus, chunks: grown, embedding: denseHashVector });
    await owner.$executeRawUnsafe(`DROP INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
    await createHnsw(owner);

    // When: HNSW results are measured only against exact results from this canonical fixture.
    let expectedCount = 0;
    let recoveredCount = 0;
    const parity: number[] = [];
    const misses: string[] = [];
    for (const query of corpus.queries) {
      const search = {
        scope: fixtureScope(parsePgvectorScope(query.scope)), query: denseHashVector(query.text),
        filters: query.filters, limit: query.limit,
      };
      const expected = await rawExactSearch(owner, search);
      const exact = await store.searchExact(search);
      const hnsw = await store.searchHnsw(search);
      expect(exact.map((hit) => hit.id), query.id).toEqual(expected.map((hit) => hit.id));
      const exactIds = new Set(exact.map((hit) => hit.id));
      const recovered = hnsw.filter((hit) => exactIds.has(hit.id)).length;
      expectedCount += exactIds.size;
      recoveredCount += recovered;
      parity.push(exactParity(expected, exact));
      if (recovered !== exactIds.size) misses.push(`${query.id}:${JSON.stringify(exact)}:${JSON.stringify(hnsw)}`);
    }
    const plan = await store.explainHnsw({
      scope: primaryScope, query: denseHashVector('scope_oracle'), filters: { product: 'HCI' }, limit: 1,
    });

    // Then: the promotion-quality gates use their specified corpus and thresholds unchanged.
    expect(grown).toHaveLength(canonicalPrimary.length * 10);
    expect(parity.every((value) => value === 1)).toBe(true);
    expect(recoveredCount / expectedCount, `${plan}\n${misses.join('\n')}`).toBeGreaterThanOrEqual(0.99);
    expect(plan).toContain('BlroRagEmbedding_embedding_hnsw_idx');
    expect(readFileSync(corpusPath)).toEqual(corpusBytes);
  });
});
