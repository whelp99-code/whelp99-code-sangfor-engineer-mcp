/** Read-only evaluation of a frozen source-labelled corpus through the local search path. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { loadRagIndex, ragSearchSync, getRagSearchDiagnostics } from '../packages/sangfor-rag/src/index.js';
import { computeRetrievalMetrics } from '../packages/sangfor-rag/src/retrieval-eval.js';

const QuerySchema = z.object({
  queryId: z.string().min(1), query: z.string().min(1), product: z.string().min(1),
  version: z.string().optional(), relevantSources: z.array(z.string()).optional(),
  hardNegativeSources: z.array(z.string()).optional(), forbiddenSources: z.array(z.string()).optional(),
});
const FixtureSchema = z.object({
  k: z.number().int().positive(), queries: z.array(QuerySchema).min(1), noAnswerQueries: z.array(QuerySchema),
});

function main(): void {
  const [indexPath, fixturePath] = process.argv.slice(2);
  if (!indexPath || !fixturePath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:eval:corpus <index.json> <qrels.json>');
  const fixtureBytes = readFileSync(fixturePath);
  const fixture = FixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
  const indexBytes = readFileSync(indexPath);
  const loadStart = performance.now();
  const index = loadRagIndex(indexPath);
  const coldLoadMs = performance.now() - loadStart;
  const rows = [...fixture.queries, ...fixture.noAnswerQueries].map((query) => {
    const started = performance.now();
    const hits = ragSearchSync({ query: query.query, product: query.product, version: query.version, limit: fixture.k, indexPath });
    const latencyMs = performance.now() - started;
    return { queryId: query.queryId, latencyMs, mode: getRagSearchDiagnostics(hits).retrievalMode,
      hits: hits.map((hit, i) => ({ queryId: query.queryId, sourceId: hit.filePath, rank: i + 1, score: hit.score })),
      hardNegativeHits: hits.filter((hit) => query.hardNegativeSources?.includes(hit.filePath)).length };
  });
  const qrels = fixture.queries.flatMap((query) => (query.relevantSources ?? []).map((sourceId) => ({ queryId: query.queryId, sourceId, grade: 1 })));
  if (qrels.length === 0) throw new Error('RAG_EVAL_POSITIVE_QRELS_REQUIRED');
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const noAnswerIds = new Set(fixture.noAnswerQueries.map((query) => query.queryId));
  const noAnswerRows = rows.filter((row) => noAnswerIds.has(row.queryId));
  console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    qrelsSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    node: process.version, cpu: cpus()[0]?.model ?? null, chunkCount: index.chunks.length,
    profile: 'local sync retrieval; legacy/unpinned vectors disabled; no reranker or external inference',
    k: fixture.k, coldLoadMs,
    meanLatencyMs: latencies.reduce((sum, n) => sum + n, 0) / latencies.length,
    p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
    metrics: computeRetrievalMetrics(qrels, rows.flatMap((row) => row.hits), fixture.k),
    noAnswerFalsePositiveRate: noAnswerRows.length ? noAnswerRows.filter((row) => row.hits.length > 0).length / noAnswerRows.length : null,
    hardNegativeHits: rows.reduce((sum, row) => sum + row.hardNegativeHits, 0), rows }, null, 2));
}

main();
