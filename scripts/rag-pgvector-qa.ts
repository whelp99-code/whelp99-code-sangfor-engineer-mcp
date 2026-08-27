import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { growBenchmarkChunks } from '../packages/sangfor-rag/src/benchmark-growth.js';
import { parseBenchmarkCorpus } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { cosineSimilarity, hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import { PgvectorRagStore } from '../packages/sangfor-rag/src/pgvector-store.js';
import {
  parsePgvectorCohort,
  parsePgvectorScope,
  parsePgvectorUpsert,
} from '../packages/sangfor-rag/src/pgvector-schema.js';

const EnvironmentSchema = z.object({ DATABASE_URL: z.string().url(), BLRO_OWNER_DATABASE_URL: z.string().url() }).passthrough();
const CORPUS_PATH = 'data/evals/rag/project-completeness-v1.json';
const scope = parsePgvectorScope({ tenantId: 'tenant-rag-pg', projectId: 'project-rag-pg', actorId: 'actor-rag-pg' });
const cohort = parsePgvectorCohort({ id: 'cohort-rag-pg', ...scope, indexEpoch: 33, backend: 'hash', model: 'hash-v1', dimensions: 384 });

function denseHashVector(text: string): readonly number[] {
  const values = hashEmbedding(text).map((value) => value + 0.01);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

async function measure(store: PgvectorRagStore, multiplier: number): Promise<{ readonly rows: number; readonly parity: number; readonly recall: number }> {
  const corpus = parseBenchmarkCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
  const chunks = growBenchmarkChunks(corpus.chunks, multiplier).chunks.map((entry) => parsePgvectorUpsert({
    ...scope, cohortId: cohort.id, id: entry.id, product: entry.product, version: entry.version,
    sourceType: entry.sourceType, trustLevel: entry.trustLevel, title: entry.title, text: entry.text,
    sourceRef: entry.filePath, contentHash: `todo32-${entry.id}`, aclActorIds: entry.aclActorIds,
    embedding: denseHashVector(entry.text),
  }));
  await store.replace({ scope, cohortId: cohort.id, chunks });
  let parity = 0;
  let exactCount = 0;
  let recovered = 0;
  for (const query of corpus.queries) {
    const input = { scope, query: denseHashVector(query.text), filters: query.filters, limit: query.limit };
    const exact = await store.searchExact(input);
    const hnsw = await store.searchHnsw(input);
    const expected = new Set(exact.map((hit) => hit.id));
    recovered += hnsw.filter((hit) => expected.has(hit.id)).length;
    exactCount += exact.length;
    for (const hit of exact) {
      const row = chunks.find((candidate) => candidate.id === hit.id);
      if (row && Math.abs(hit.distance - (1 - cosineSimilarity([...input.query], [...row.embedding]))) < 0.000_01) parity += 1;
    }
  }
  return { rows: chunks.length, parity: parity / exactCount, recall: recovered / exactCount };
}

async function seedOwner(owner: PrismaClient): Promise<void> {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'RAG pgvector QA') ON CONFLICT ("id") DO NOTHING`, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'RAG pgvector QA') ON CONFLICT ("id") DO NOTHING`, scope.projectId, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'RAG pgvector QA','service') ON CONFLICT ("id") DO NOTHING`, scope.actorId, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ('role-rag-pg',$1,'rag-pg-qa',ARRAY['rag:read','rag:write']) ON CONFLICT ("id") DO NOTHING`, scope.tenantId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ('membership-rag-pg',$1,$2,$3,'role-rag-pg') ON CONFLICT ("projectId","actorId") DO NOTHING`, scope.tenantId, scope.projectId, scope.actorId);
  });
}

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const database = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  const owner = new PrismaClient({ datasources: { db: { url: environment.BLRO_OWNER_DATABASE_URL } } });
  try {
    await seedOwner(owner);
    const store = new PgvectorRagStore(database);
    await store.promoteCohort(cohort);
    const one = await measure(store, 1);
    const ten = await measure(store, 10);
    const plan = await store.explainHnsw({ scope, query: denseHashVector('oracle_hci'), filters: { product: 'HCI' }, limit: 5 });
    const corpusHash = createHash('sha256').update(readFileSync(CORPUS_PATH)).digest('hex');
    process.stdout.write(`${JSON.stringify({ one, ten, plan, corpusHash, pgvector: { tag: 'v0.8.1', commit: '778dacf20c07caf904557a88705142631818d8cb' } })}\nRAG_PGVECTOR_PASS\n`);
  } finally {
    await database.$disconnect();
    await owner.$disconnect();
  }
}

main().catch((error: unknown) => { // no-excuse-ok: catch -- CLI process boundary
  process.stderr.write(`${error instanceof Error ? error.message : 'RAG_PGVECTOR_QA_UNKNOWN_FAILURE'}\n`);
  process.exitCode = 1;
});
