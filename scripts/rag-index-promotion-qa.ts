import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { parseBenchmarkCorpus } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import { buildUnmeasuredIndexPromotionQaReport } from '../packages/sangfor-rag/src/index-promotion-qa-report.js';
import { PgvectorRagStore } from '../packages/sangfor-rag/src/pgvector-store.js';
import { parsePgvectorCohort, parsePgvectorScope, parsePgvectorUpsert } from '../packages/sangfor-rag/src/pgvector-schema.js';
import { PGVECTOR_HASH_EMBEDDING_SPACE } from '../packages/sangfor-rag/src/pgvector-types.js';

const EnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(), BLRO_OWNER_DATABASE_URL: z.string().url(),
}).passthrough();
const CORPUS_PATH = 'data/evals/rag/project-completeness-v1.json';
const INDEX_NAME = 'BlroRagEmbedding_embedding_hnsw_idx';
const scope = parsePgvectorScope({ tenantId: 'tenant-rag-promotion-qa', projectId: 'project-rag-promotion-qa', actorId: 'actor-rag-promotion-qa' });
const cohort = parsePgvectorCohort({ ...scope, id: 'cohort-rag-promotion-qa', indexEpoch: 34, backend: 'hash', model: 'hash', dimensions: 384, embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE });

type Measurement = { readonly ids: readonly string[]; readonly durations: readonly number[] };

function denseVector(text: string): readonly number[] {
  return hashEmbedding(text);
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function measure(store: PgvectorRagStore, corpus: ReturnType<typeof parseBenchmarkCorpus>, backend: 'exact' | 'hnsw'): Promise<Measurement> {
  const ids: string[] = [];
  const durations: number[] = [];
  for (const query of corpus.queries) {
    const input = { scope, query: denseVector(query.text), embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE, filters: query.filters, limit: query.limit };
    const started = performance.now();
    const hits = backend === 'exact' ? await store.searchExact(input) : await store.searchHnsw(input);
    durations.push(performance.now() - started);
    ids.push(...hits.map((hit) => `${query.id}:${hit.id}`));
  }
  return { ids, durations };
}

async function seedOwner(owner: PrismaClient): Promise<void> {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'RAG promotion QA') ON CONFLICT ("id") DO NOTHING`, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'RAG promotion QA') ON CONFLICT ("id") DO NOTHING`, scope.projectId, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'RAG promotion QA','service') ON CONFLICT ("id") DO NOTHING`, scope.actorId, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ('role-rag-promotion-qa',$1,'rag-promotion-qa',ARRAY['rag:read','rag:write']) ON CONFLICT ("id") DO NOTHING`, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ('membership-rag-promotion-qa',$1,$2,$3,'role-rag-promotion-qa') ON CONFLICT ("projectId","actorId") DO NOTHING`, scope.tenantId, scope.projectId, scope.actorId);
  });
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--');
  const output = argumentsList[0];
  if (!output || argumentsList.length !== 1) throw new TypeError('Usage: rag-index-promotion-qa REPORT_PATH');
  const environment = EnvironmentSchema.parse(process.env);
  const owner = new PrismaClient({ datasources: { db: { url: environment.BLRO_OWNER_DATABASE_URL } } });
  const database = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  try {
    await seedOwner(owner);
    const corpus = parseBenchmarkCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
    const authoritative = corpus.chunks.filter((entry) => entry.tenantId === 'tenant-alpha' && entry.projectId === 'project-alpha');
    const rows = authoritative.map((entry) => parsePgvectorUpsert({
      ...scope, cohortId: cohort.id, id: entry.id, product: entry.product, version: entry.version,
      sourceType: entry.sourceType, trustLevel: entry.trustLevel, title: entry.title, text: entry.text,
      sourceRef: entry.filePath, contentHash: `todo32-${entry.id}`,
      aclActorIds: entry.aclActorIds.map((actor) => actor === 'actor-alpha' ? scope.actorId : actor),
      embedding: denseVector(entry.text),
      embeddingSpace: PGVECTOR_HASH_EMBEDDING_SPACE,
    }));
    const store = new PgvectorRagStore(database);
    await store.promoteCohort(cohort);
    await store.replace({ scope, cohortId: cohort.id, chunks: rows });
    await store.upsert(rows[0] ?? (() => { throw new TypeError('RAG_INDEX_PROMOTION_QA_CORPUS_EMPTY'); })());
    await owner.$executeRawUnsafe(`REINDEX INDEX "BlroRagEmbedding_embedding_hnsw_idx"`);
    const exact = await measure(store, corpus, 'exact');
    const candidate = await measure(store, corpus, 'hnsw');
    const exactSet = new Set(exact.ids);
    const recovered = candidate.ids.filter((id) => exactSet.has(id)).length;
    const forbidden = new Set(corpus.queries.flatMap((query) => query.forbiddenIds.map((id) => `${query.id}:${id}`)));
    const report = buildUnmeasuredIndexPromotionQaReport({
      benchmarkDigest: createHash('sha256').update(readFileSync(CORPUS_PATH)).digest('hex'),
      benchmarkQueryCount: corpus.queries.length,
      recallAtK: exact.ids.length === 0 ? 0 : recovered / exact.ids.length,
      exactP95Ms: p95(exact.durations),
      candidateP95Ms: p95(candidate.durations),
      scopeIsolationProof: candidate.ids.every((id) => !forbidden.has(id)),
      index: INDEX_NAME,
    });
    writeFileSync(output, `${JSON.stringify(report)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ report: output, ...report })}\nRAG_INDEX_PROMOTION_NOT_ELIGIBLE\n`);
    process.exitCode = 2;
  } finally {
    await database.$disconnect();
    await owner.$disconnect();
  }
}

main().catch((error: unknown) => { // no-excuse-ok: catch -- QA process boundary
  process.stderr.write(`${error instanceof Error ? error.message : 'RAG_INDEX_PROMOTION_QA_UNKNOWN_FAILURE'}\n`);
  process.exitCode = 1;
});
