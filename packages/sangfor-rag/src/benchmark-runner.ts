import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { computeRetrievalMetrics } from './retrieval-eval.js';
import { buildVectors, filterBenchmarkCandidates, rankExactCandidates, type QueryAudit } from './benchmark-search.js';
import { growBenchmarkChunks } from './benchmark-growth.js';
import { deriveBenchmarkCoverage } from './benchmark-registry.js';
import type { BenchmarkCorpus } from './benchmark-schema.js';
import { BenchmarkRefusal, sha256 } from './benchmark-schema.js';

export type SampleMetrics = {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
};
const RuntimeMetadataSchema = z.object({
  node: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  cpu: z.string().min(1),
  cores: z.number().int().positive(),
  memoryBytes: z.number().int().positive()
}).strict();

export type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>;

export function parseRuntimeMetadata(value: unknown): RuntimeMetadata {
  const parsed = RuntimeMetadataSchema.safeParse(value);
  if (!parsed.success) throw new BenchmarkRefusal('RUNTIME_METADATA_MISSING', parsed.error.issues.map((issue) => issue.path.join('.')).join(','));
  return parsed.data;
}

function samples(values: readonly number[]): SampleMetrics {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
  return { samples: values.length, p50Ms: at(0.5), p95Ms: at(0.95) };
}

export function runExactBenchmark(corpus: BenchmarkCorpus, growthMultiplier: number, runtimeInput: RuntimeMetadata): Record<string, unknown> {
  const runtime = parseRuntimeMetadata(runtimeInput);
  const coverage = deriveBenchmarkCoverage(corpus);
  const growthStarted = performance.now();
  const growth = growBenchmarkChunks(corpus.chunks, growthMultiplier);
  const growthMs = performance.now() - growthStarted;
  const rssBefore = process.memoryUsage().rss;
  const buildDurations: number[] = [];
  let vectors = buildVectors(growth.chunks, corpus.cohort.dimensions);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const started = performance.now();
    vectors = buildVectors(growth.chunks, corpus.cohort.dimensions);
    buildDurations.push(performance.now() - started);
  }
  const buildStarted = performance.now();
  vectors = buildVectors(growth.chunks, corpus.cohort.dimensions);
  buildDurations.push(performance.now() - buildStarted);
  const rssAfterBuild = process.memoryUsage().rss;
  const updateDurations: number[] = [];
  const first = vectors[0];
  if (first) {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const started = performance.now();
      const replacement = buildVectors([{ ...first, text: `${first.text} update-${iteration}` }], corpus.cohort.dimensions)[0];
      if (!replacement) throw new BenchmarkRefusal('UPDATE_BENCHMARK_FAILED', 'replacement vector was not generated');
      vectors = [replacement, ...vectors.slice(1)];
      updateDurations.push(performance.now() - started);
    }
    vectors = buildVectors(growth.chunks, corpus.cohort.dimensions);
  }
  const allIds = new Set(corpus.chunks.map((chunk) => chunk.id));
  const queryDurations: number[] = [];
  const audits: QueryAudit[] = [];
  let forbiddenHitCount = 0;
  for (const query of corpus.queries) {
    const started = performance.now();
    const candidates = filterBenchmarkCandidates(vectors, query);
    const candidateIds = candidates.map((candidate) => candidate.id);
    for (const expectedId of query.expectedIds) {
      if (!allIds.has(expectedId)) throw new BenchmarkRefusal('EXPECTED_RESULT_MISSING', `${query.id}:${expectedId}`);
      if (!candidateIds.includes(expectedId)) throw new BenchmarkRefusal('EXPECTED_RESULT_OUT_OF_SCOPE', `${query.id}:${expectedId}`);
    }
    const forbiddenCandidates = query.forbiddenIds.filter((id) => candidateIds.includes(id));
    if (forbiddenCandidates.length > 0) throw new BenchmarkRefusal('FORBIDDEN_CANDIDATE', `${query.id}:${forbiddenCandidates.join(',')}`);
    const hits = rankExactCandidates(candidates, query, corpus.cohort.dimensions);
    queryDurations.push(performance.now() - started);
    const hitIds = hits.map((hit) => hit.id);
    for (const expectedId of query.expectedIds) {
      if (!hitIds.includes(expectedId)) throw new BenchmarkRefusal('EXPECTED_RESULT_MISSING', `${query.id}:${expectedId}`);
    }
    const forbiddenHits = query.forbiddenIds.filter((id) => hitIds.includes(id));
    forbiddenHitCount += forbiddenHits.length;
    if (query.expectedIds.length === 0 && hitIds.length > 0) throw new BenchmarkRefusal('NO_RESULT_FALSE_HIT', `${query.id}:${hitIds.join(',')}`);
    audits.push({ id: query.id, candidateIds, hitIds, expectedIds: query.expectedIds, forbiddenIds: query.forbiddenIds });
  }
  const qrels = corpus.queries.flatMap((query) => query.expectedIds.map((sourceId) => ({ queryId: query.id, sourceId, grade: 1 })));
  const runHits = audits.flatMap((audit) => audit.hitIds.map((sourceId, index) => ({ queryId: audit.id, sourceId, rank: index + 1, score: audit.hitIds.length - index })));
  const k = Math.max(...corpus.queries.map((query) => query.limit));
  const metrics = computeRetrievalMetrics(qrels, runHits, k);
  if (metrics.recallAtK !== 1 || metrics.hitRateAtK !== 1 || forbiddenHitCount !== 0) {
    throw new BenchmarkRefusal('EXACT_BASELINE_QUALITY_REFUSAL', JSON.stringify({ recallAtK: metrics.recallAtK, hitRateAtK: metrics.hitRateAtK, forbiddenHitCount }));
  }
  const stableResult = { queries: audits, metrics, growth: growth.generatedDigest };
  const rssAfter = process.memoryUsage().rss;
  return {
    schemaVersion: 'rag-index-benchmark-report.v1',
    corpusId: corpus.corpusId,
    corpusDigest: corpus.corpusDigest,
    generatedGrowthDigest: growth.generatedDigest,
    resultDigest: sha256(JSON.stringify(stableResult)),
    backend: 'exact',
    cohort: corpus.cohort,
    coverage,
    dataset: { baseChunkCount: corpus.chunks.length, chunkCount: growth.chunks.length, generatedChunkCount: growth.generatedCount, queryCount: corpus.queries.length, growthMultiplier },
    queries: audits,
    forbiddenHitCount,
    metrics,
    timing: { growth: samples([growthMs]), build: samples(buildDurations), update: samples(updateDurations), query: samples(queryDurations) },
    memory: { deltaBytes: rssAfter - rssBefore, buildDeltaBytes: rssAfterBuild - rssBefore, peakBytes: Math.max(rssBefore, rssAfterBuild, rssAfter) },
    runtime
  };
}
