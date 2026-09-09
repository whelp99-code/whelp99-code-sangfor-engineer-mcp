/** Read-only evaluation of a frozen source-labelled corpus through the local search path. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { compareCorpusQuality, corpusQualityThresholdsSchema, corpusReportSchema } from '../packages/sangfor-rag/src/corpus-eval-gate.js';
import { corpusEvalFixtureSchema } from '../packages/sangfor-rag/src/corpus-eval-contract.js';
import { loadRagIndex, ragSearch, ragSearchSync, getRagSearchDiagnostics } from '../packages/sangfor-rag/src/index.js';
import { computeRetrievalMetrics } from '../packages/sangfor-rag/src/retrieval-eval.js';
import { createLocalRerankFromEnv } from '../packages/sangfor-rag/src/local-rerank-provider.js';
import { localScoreOrderFromEnv } from '../packages/sangfor-rag/src/local-score-order.js';

async function main(): Promise<void> {
  const [indexPath, fixturePath, baselinePath] = process.argv.slice(2);
  if (!indexPath || !fixturePath || (process.argv.length !== 4 && process.argv.length !== 5)) throw new Error('Usage: pnpm run rag:eval:corpus <index.json> <qrels.json> [baseline-report.json]');
  const fixtureBytes = readFileSync(fixturePath);
  const fixture = corpusEvalFixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
  const baselineBytes = baselinePath ? readFileSync(baselinePath) : undefined;
  const baseline = baselineBytes ? JSON.parse(baselineBytes.toString('utf8')) : undefined;
  const thresholds = baselinePath ? corpusQualityThresholdsSchema.parse(JSON.parse(fixtureBytes.toString('utf8')).thresholds) : undefined;
  if (baselinePath) corpusReportSchema.parse(baseline);
  const indexBytes = readFileSync(indexPath);
  const settings = {
    hybridAlpha: process.env.SANGFOR_RAG_HYBRID_ALPHA ?? null,
    ...(process.env.SANGFOR_RAG_LEXICAL_PROFILE ? { lexicalProfile: process.env.SANGFOR_RAG_LEXICAL_PROFILE } : {}),
    allowCustomer: process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1',
    execution: process.env.SANGFOR_RAG_EVAL_ASYNC === '1' ? 'async-configured-provider' : 'local-sync-no-external-inference',
    ...(process.env.SANGFOR_RAG_EVAL_ASYNC === '1' ? {
      embeddingModel: process.env.SANGFOR_RAPID_MLX_EMBEDDING_MODEL ?? null,
      embeddingRevision: process.env.SANGFOR_EMBEDDING_MODEL_REVISION ?? null,
      localRerankerEnabled: process.env.SANGFOR_LOCAL_RERANK_ENABLED === '1',
      localRerankerPassages: process.env.SANGFOR_LOCAL_RERANK_PASSAGES === '2' ? 2 : 1,
      localReranker: process.env.SANGFOR_LOCAL_RERANK_MODEL ?? null,
      localRerankerRevision: process.env.SANGFOR_LOCAL_RERANK_REVISION ?? null,
      ...(process.env.SANGFOR_LOCAL_RERANK_ENABLED === '1' ? {
        localRerankerConfigurationSha256: createLocalRerankFromEnv()!.configurationSha256,
        localRerankerMinimumScore: createLocalRerankFromEnv()!.minimumScore ?? null,
        ...(process.env.SANGFOR_LOCAL_RERANK_MIN_SCORE !== undefined ? { localRerankerScoreOrder: localScoreOrderFromEnv() } : {}),
      } : {}),
      ...(process.env.SANGFOR_LOCAL_RERANK_ENABLED === '1' || process.env.SANGFOR_MIMO_RERANK_ENABLED === '1' ? {
        rerankCandidates: process.env.SANGFOR_MIMO_RERANK_CANDIDATES ?? '40',
        rerankTimeoutMs: process.env.SANGFOR_MIMO_RERANK_TIMEOUT_MS ?? '5000',
      } : {}),
      rerankDisabled: process.env.SANGFOR_MIMO_RERANK_ENABLED === '0',
    } : {}),
    ...(process.env.SANGFOR_RAG_REQUIRE_SUBJECT_MATCH === '1' ? { requireSubjectMatch: true } : {}),
    ...(process.env.SANGFOR_RAG_FUSION ? { fusion: process.env.SANGFOR_RAG_FUSION } : {}),
  };
  const implementationSha256 = createHash('sha256');
  const implementationFiles = ['package.json', 'pnpm-lock.yaml', 'scripts/rag-corpus-eval.ts', 'packages/sangfor-rag/src/corpus-eval-contract.ts',
    'packages/sangfor-rag/src/rag-search.ts', 'packages/sangfor-rag/src/rag-search-diagnostics.ts', 'packages/sangfor-rag/src/rag-ranking.ts',
    'packages/sangfor-rag/src/hit-context.ts', 'packages/sangfor-rag/src/query-evidence.ts', 'packages/sangfor-rag/src/query-evidence-requirement.ts', 'packages/sangfor-rag/src/retrieval-text.ts', 'packages/sangfor-rag/src/bm25.ts', 'packages/sangfor-rag/src/query-normalization.ts',
    'packages/sangfor-rag/src/retrieval-eval.ts', 'packages/sangfor-rag/src/corpus-eval-gate.ts',
    'packages/sangfor-rag/src/hash-embedding.ts', 'packages/sangfor-rag/src/embedding-space.ts',
    'packages/sangfor-rag/src/embedding-profile.ts', 'packages/sangfor-rag/src/rag-product.ts',
    'packages/sangfor-rag/src/rag-index-store.ts', 'packages/sangfor-rag/src/embedding-provider.ts',
    'packages/sangfor-rag/src/rapid-mlx-provider.ts', 'packages/sangfor-rag/src/openai-embeddings-client.ts',
    'packages/sangfor-rag/src/mimo-rerank-provider.ts', 'packages/sangfor-rag/src/local-rerank-provider.ts', 'packages/sangfor-rag/src/local-score-order.ts'];
  for (const file of implementationFiles) {
    implementationSha256.update(file).update(readFileSync(new URL('../' + file, import.meta.url)));
  }
  const loadStart = performance.now();
  const index = loadRagIndex(indexPath);
  const coldLoadMs = performance.now() - loadStart;
  const rows: Array<{ queryId: string; product: string; language: string; latencyMs: number;
    mode: ReturnType<typeof getRagSearchDiagnostics>['retrievalMode']; diagnostics: ReturnType<typeof getRagSearchDiagnostics>;
    hits: Array<{ queryId: string; sourceId: string; rank: number; score: number; rerankScore?: number }>;
    forbiddenHits: number; hardNegativeHits: number }> = [];
  for (const query of [...fixture.queries, ...fixture.noAnswerQueries]) {
    const started = performance.now();
    const input = { query: query.query, product: query.product, version: query.version, limit: fixture.k, indexPath };
    const hits = process.env.SANGFOR_RAG_EVAL_ASYNC === '1' ? await ragSearch(input) : ragSearchSync(input);
    const latencyMs = performance.now() - started;
    rows.push({ queryId: query.queryId, product: query.product, language: query.language ?? 'unknown', latencyMs, mode: getRagSearchDiagnostics(hits).retrievalMode,
      diagnostics: getRagSearchDiagnostics(hits),
      hits: hits.map((hit, i) => ({ queryId: query.queryId, sourceId: hit.filePath, rank: i + 1, score: hit.score, rerankScore: hit.rerankScore })),
      forbiddenHits: hits.filter((hit) => query.forbiddenSources?.includes(hit.filePath)).length,
      hardNegativeHits: hits.filter((hit) => query.hardNegativeSources?.includes(hit.filePath)).length });
  }
  const qrels = fixture.queries.flatMap((query) => (query.relevantSources ?? []).map((sourceId) => ({ queryId: query.queryId, sourceId, grade: 1 })));
  if (qrels.length === 0) throw new Error('RAG_EVAL_POSITIVE_QRELS_REQUIRED');
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const noAnswerIds = new Set(fixture.noAnswerQueries.map((query) => query.queryId));
  const noAnswerRows = rows.filter((row) => noAnswerIds.has(row.queryId));
  if (!readFileSync(indexPath).equals(indexBytes) || !readFileSync(fixturePath).equals(fixtureBytes)) {
    throw new Error('RAG_EVAL_INPUT_CHANGED_DURING_RUN');
  }
  const qrelSources = new Set(index.chunks.map((chunk) => chunk.filePath));
  const missingRelevantSources = [...new Set(qrels.map((row) => row.sourceId))].filter((source) => !qrelSources.has(source));
  const bySlice = (field: 'product' | 'language') => Object.fromEntries(
    [...new Set(fixture.queries.map((query) => query[field] ?? 'unknown'))].sort().map((value) => {
      const ids = new Set(fixture.queries.filter((query) => (query[field] ?? 'unknown') === value).map((query) => query.queryId));
      return [value, computeRetrievalMetrics(qrels.filter((row) => ids.has(row.queryId)), rows.flatMap((row) => row.hits), fixture.k)];
    }));
  const report = { schemaVersion: 2, generatedAt: new Date().toISOString(),
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    qrelsSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    implementationSha256: implementationSha256.digest('hex'), implementationFiles, settings,
    settingsSha256: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
    evaluationOnly: true, promotionStatus: 'NOT_EVALUATED',
    missingRelevantSources, positiveQueryCount: fixture.queries.length, noAnswerQueryCount: fixture.noAnswerQueries.length,
    byProduct: bySlice('product'), byLanguage: bySlice('language'),
    node: process.version, cpu: cpus()[0]?.model ?? null, chunkCount: index.chunks.length,
    profile: process.env.SANGFOR_RAG_EVAL_ASYNC === '1' ? 'async retrieval; actual providers and degradation recorded per query' : 'local sync retrieval; legacy/unpinned vectors disabled; no reranker or external inference',
    k: fixture.k, coldLoadMs,
    meanLatencyMs: latencies.reduce((sum, n) => sum + n, 0) / latencies.length,
    p50LatencyMs: latencies[Math.ceil(latencies.length * 0.5) - 1],
    p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
    metrics: computeRetrievalMetrics(qrels, rows.flatMap((row) => row.hits), fixture.k),
    noAnswerFalsePositiveRate: noAnswerRows.length ? noAnswerRows.filter((row) => row.hits.length > 0).length / noAnswerRows.length : null,
    forbiddenHits: rows.reduce((sum, row) => sum + row.forbiddenHits, 0),
    hardNegativeQueryRate: rows.filter((row) => !noAnswerIds.has(row.queryId) && row.hardNegativeHits > 0).length / fixture.queries.length,
    hardNegativeHits: rows.reduce((sum, row) => sum + row.hardNegativeHits, 0), rows };
  const comparison = baselinePath ? compareCorpusQuality(report, baseline, thresholds) : null;
  console.log(JSON.stringify({ ...report, comparison,
    baselineReportSha256: baselineBytes ? createHash('sha256').update(baselineBytes).digest('hex') : null }, null, 2));
  if (comparison?.decision === 'NOT_ELIGIBLE') process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
