import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { BenchmarkChunk, BenchmarkCorpus } from '../../packages/sangfor-rag/src/benchmark-schema.js';
import { cosineSimilarity } from '../../packages/sangfor-rag/src/hash-embedding.js';
import { vectorLiteral } from '../../packages/sangfor-rag/src/pgvector-sql.js';
import { parsePgvectorCohort, parsePgvectorScope, parsePgvectorUpsert } from '../../packages/sangfor-rag/src/pgvector-schema.js';
import { PgvectorRagStore } from '../../packages/sangfor-rag/src/pgvector-store.js';
import type { PgvectorHit, PgvectorScope, PgvectorSearch, PgvectorUpsert } from '../../packages/sangfor-rag/src/pgvector-types.js';

type FixtureInput = {
  readonly owner: PrismaClient;
  readonly store: PgvectorRagStore;
  readonly corpus: BenchmarkCorpus;
  readonly chunks: readonly BenchmarkChunk[];
  readonly embedding: (text: string) => readonly number[];
};

type ScopeKey = `${string}\0${string}`;

function key(tenantId: string, projectId: string): ScopeKey {
  return `${tenantId}\0${projectId}`;
}

function databaseProjectId(tenantId: string, projectId: string): string {
  return `rag-fixture-${tenantId}-${projectId}`;
}

function writerActorId(tenantId: string): string {
  return `rag-fixture-writer-${tenantId}`;
}

export function fixtureScope(scope: { readonly tenantId: string; readonly projectId: string; readonly actorId: string }): PgvectorScope {
  return parsePgvectorScope({
    tenantId: scope.tenantId,
    projectId: databaseProjectId(scope.tenantId, scope.projectId),
    actorId: scope.actorId,
  });
}

export function fixtureProjectIds(corpus: BenchmarkCorpus): readonly string[] {
  const ids = new Set(corpus.chunks.map((chunk) => databaseProjectId(chunk.tenantId, chunk.projectId)));
  for (const query of corpus.queries) ids.add(databaseProjectId(query.scope.tenantId, query.scope.projectId));
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export async function cleanupRagProjects(owner: PrismaClient, projectIds: readonly string[]): Promise<void> {
  for (const projectId of projectIds) {
    if (projectId !== 'project-rag-pg' && !projectId.startsWith('rag-fixture-')) {
      throw new TypeError('RAG_POSTGRES_FIXTURE_CLEANUP_SCOPE_REFUSED');
    }
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagIndexPromotionEvidence" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagIndexPromotion" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagEmbedding" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagAuthoritativeChunk" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagEmbeddingCohort" WHERE "projectId"=$1`, projectId);
    });
  }
}

async function seedAuthority(owner: PrismaClient, scopes: ReadonlyMap<ScopeKey, PgvectorScope>): Promise<void> {
  const tenants = new Set([...scopes.values()].map(({ tenantId }) => tenantId));
  await owner.$transaction(async (transaction) => {
    for (const tenantId of tenants) {
      const writerId = writerActorId(tenantId);
      const roleId = `rag-fixture-role-${tenantId}`;
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2) ON CONFLICT ("id") DO NOTHING`,
        tenantId, `RAG fixture ${tenantId}`,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,'service') ON CONFLICT ("id") DO NOTHING`,
        writerId, tenantId, `RAG writer ${tenantId}`,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,$3,ARRAY['rag:read','rag:write']) ON CONFLICT ("id") DO NOTHING`,
        roleId, tenantId, `RAG fixture ${tenantId}`,
      );
    }
    for (const scope of scopes.values()) {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      const writerId = writerActorId(scope.tenantId);
      const roleId = `rag-fixture-role-${scope.tenantId}`;
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3) ON CONFLICT ("id") DO NOTHING`,
        scope.projectId, scope.tenantId, `RAG fixture ${scope.projectId}`,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("projectId","actorId") DO NOTHING`,
        `membership-${scope.projectId}`, scope.tenantId, scope.projectId, writerId, roleId,
      );
    }
  });
}

export type ExpectedHit = { readonly id: string; readonly distance: number };

export function expectedExact(rows: readonly PgvectorUpsert[], search: PgvectorSearch): readonly ExpectedHit[] {
  return rows.filter((row) =>
    row.tenantId === search.scope.tenantId && row.projectId === search.scope.projectId
    && (row.aclActorIds.length === 0 || row.aclActorIds.includes(search.scope.actorId))
    && (!search.filters.product || row.product === search.filters.product)
    && (!search.filters.version || row.version === search.filters.version)
    && (!search.filters.sourceType || row.sourceType === search.filters.sourceType)
    && (!search.filters.trustLevel || row.trustLevel === search.filters.trustLevel))
    .map((row) => ({ id: row.id, distance: 1 - cosineSimilarity([...search.query], [...row.embedding]) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, search.limit);
}

const RawExactHitSchema = z.object({ id: z.string(), distance: z.number() }).strict();

export async function rawExactSearch(owner: PrismaClient, search: PgvectorSearch): Promise<readonly ExpectedHit[]> {
  return owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, search.scope.projectId);
    await transaction.$executeRawUnsafe('SET LOCAL enable_indexscan=off');
    await transaction.$executeRawUnsafe('SET LOCAL enable_bitmapscan=off');
    return z.array(RawExactHitSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
      SELECT e."chunkId" AS "id",(e."embedding" <=> $8::vector) AS "distance"
      FROM "BlroRagEmbedding" e
      WHERE e."tenantId"=$1 AND e."projectId"=$2 AND e."cohortId"=$4
        AND (cardinality(e."aclActorIds")=0 OR $3=ANY(e."aclActorIds"))
        AND ($5::text IS NULL OR e."product"=$5)
        AND ($6::text IS NULL OR e."version"=$6)
        AND ($7::text IS NULL OR e."sourceType"=$7)
        AND ($9::text IS NULL OR e."trustLevel"=$9)
      ORDER BY e."embedding" <=> $8::vector,e."chunkId"
      LIMIT $10`,
    search.scope.tenantId, search.scope.projectId, search.scope.actorId, `cohort-${search.scope.projectId}`,
    search.filters.product ?? null, search.filters.version ?? null, search.filters.sourceType ?? null,
    vectorLiteral(search.query), search.filters.trustLevel ?? null, search.limit));
  });
}

export function exactParity(expected: readonly ExpectedHit[], actual: readonly PgvectorHit[]): number {
  if (actual.length === 0) return expected.length === 0 ? 1 : 0;
  const expectedById = new Map(expected.map((hit) => [hit.id, hit.distance]));
  return actual.filter((hit) => {
    const distance = expectedById.get(hit.id);
    return distance !== undefined && Math.abs(hit.distance - distance) < 0.000_01;
  }).length / actual.length;
}

export async function buildScopeFirstCorpusFixture(input: FixtureInput): Promise<readonly PgvectorUpsert[]> {
  const sourceScopes = new Map<ScopeKey, PgvectorScope>();
  for (const chunk of input.chunks) {
    const scope = parsePgvectorScope({ tenantId: chunk.tenantId, projectId: chunk.projectId, actorId: writerActorId(chunk.tenantId) });
    sourceScopes.set(key(chunk.tenantId, chunk.projectId), fixtureScope(scope));
  }
  for (const query of input.corpus.queries) {
    sourceScopes.set(key(query.scope.tenantId, query.scope.projectId), fixtureScope(query.scope));
  }
  await seedAuthority(input.owner, sourceScopes);
  const rows = input.chunks.map((chunk) => {
    const scope = sourceScopes.get(key(chunk.tenantId, chunk.projectId));
    if (!scope) throw new TypeError('RAG_POSTGRES_FIXTURE_SCOPE_MISSING');
    return parsePgvectorUpsert({
      ...scope, actorId: writerActorId(scope.tenantId), cohortId: `cohort-${scope.projectId}`,
      id: chunk.id, product: chunk.product, version: chunk.version, sourceType: chunk.sourceType,
      trustLevel: chunk.trustLevel, title: chunk.title, text: chunk.text, sourceRef: chunk.filePath,
      contentHash: `scope-first-${chunk.id}`, aclActorIds: chunk.aclActorIds,
      embedding: input.embedding(chunk.text),
    });
  });
  for (const scope of sourceScopes.values()) {
    const active = parsePgvectorCohort({
      ...scope, id: `cohort-${scope.projectId}`, indexEpoch: 35,
      backend: 'hash', model: 'hash-v1', dimensions: input.corpus.cohort.dimensions,
    });
    await input.store.promoteCohort(active);
    await input.store.replace({
      scope, cohortId: active.id,
      chunks: rows.filter((row) => row.tenantId === scope.tenantId && row.projectId === scope.projectId),
    });
  }
  return rows;
}
