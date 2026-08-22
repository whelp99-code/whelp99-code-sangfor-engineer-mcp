#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';

const qrelsPath = process.argv[2] ?? 'data/evals/issue-15/cross-product-qrels.json';
const outputPath = process.argv[3] ?? 'data/evals/issue-15/ab-evaluation.json';
const baselineIndex = process.argv[4] ?? 'data/rag/index.json';
const candidateIndex = process.argv[5] ?? 'data/evals/issue-14/e5-single-profile-index.json';
const benchmark = JSON.parse(readFileSync(qrelsPath, 'utf8'));
const { queries, noAnswerQueries, k, thresholds } = benchmark;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const dcg = (grades) => grades.reduce((sum, grade, i) => sum + ((2 ** grade - 1) / Math.log2(i + 2)), 0);

function score(run) {
  let hit = 0, recall = 0, reciprocalRank = 0, ndcg = 0, hardNegativeQueries = 0;
  for (const query of queries) {
    const relevant = new Set(query.relevantSources);
    const negatives = new Set(query.hardNegativeSources);
    const seen = new Set();
    const ranked = run.filter((row) => row.queryId === query.queryId && !seen.has(row.sourceId) && seen.add(row.sourceId)).slice(0, k);
    const grades = ranked.map((row) => relevant.has(row.sourceId) ? 3 : 0);
    const found = new Set(ranked.filter((row) => relevant.has(row.sourceId)).map((row) => row.sourceId)).size;
    const first = grades.findIndex((grade) => grade > 0);
    hit += found > 0 ? 1 : 0;
    recall += found / relevant.size;
    reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
    ndcg += dcg(grades) / dcg(Array(relevant.size).fill(3));
    hardNegativeQueries += ranked.some((row) => negatives.has(row.sourceId)) ? 1 : 0;
  }
  return {
    queryCount: queries.length,
    hitRateAt5: hit / queries.length,
    recallAt5: recall / queries.length,
    mrrAt5: reciprocalRank / queries.length,
    ndcgAt5: ndcg / queries.length,
    hardNegativeQueryRateAt5: hardNegativeQueries / queries.length
  };
}

async function runArm({ name, indexPath, baseUrl, model }) {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/mcp-server/src/index.ts'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MCP_PROBE: '1', SANGFOR_SEARCH_GAP_CAPTURE: '0', SANGFOR_RAPID_MLX_BASE_URL: baseUrl, SANGFOR_RAPID_MLX_EMBEDDING_MODEL: model, SANGFOR_RAPID_MLX_BATCH_SIZE: '64' }
  });
  let buffer = '', nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const started = performance.now(), latenciesMs = [], run = [], noAnswerResults = [];
  let diagnostics;
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `issue-15-${name}`, version: '1.0' } });
    for (const query of [...queries, ...noAnswerQueries]) {
      const queryStarted = performance.now();
      const result = await rpc('tools/call', { name: 'sangfor_rag_search', arguments: { query: query.query, ...(query.version ? { product: query.product, version: query.version } : {}), limit: k, indexPath, privacy_mode: 'raw' } });
      latenciesMs.push(performance.now() - queryStarted);
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} MCP search failed`);
      const hits = result.structuredContent;
      if (!Array.isArray(hits)) throw new Error(`${name} MCP returned a non-array result`);
      if (query.version) {
        const forbidden = new Set(query.forbiddenSources);
        const retrievedForbiddenSources = [...new Set(hits.map((hit) => hit.filePath).filter((path) => forbidden.has(path)))];
        noAnswerResults.push({ queryId: query.queryId, hitCount: hits.length, retrievedForbiddenSources, passed: retrievedForbiddenSources.length === 0 });
      }
      else hits.forEach((entry, index) => run.push({ queryId: query.queryId, sourceId: entry.filePath, rank: index + 1, score: entry.score, title: entry.title }));
    }
    diagnostics = (await rpc('tools/call', { name: 'sangfor_rag_index_summary', arguments: { indexPath } })).structuredContent;
  } finally { child.kill(); }
  const metrics = score(run);
  metrics.noAnswerFalsePositiveRateAt5 = noAnswerResults.filter((row) => !row.passed).length / noAnswerResults.length;
  return { name, indexPath, baseUrl, model, elapsedMs: performance.now() - started, meanQueryLatencyMs: latenciesMs.reduce((a,b)=>a+b,0)/latenciesMs.length, p95QueryLatencyMs: [...latenciesMs].sort((a,b)=>a-b)[Math.ceil(latenciesMs.length*.95)-1], metrics, diagnostics, noAnswerResults, run };
}

const baseline = await runArm({ name: 'current-mixed-minilm-query', indexPath: baselineIndex, baseUrl: 'http://127.0.0.1:8000/v1', model: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2' });
const candidate = await runArm({ name: 'e5-small-single-profile', indexPath: candidateIndex, baseUrl: 'http://127.0.0.1:8001/v1', model: 'intfloat/multilingual-e5-small' });
const delta = Object.fromEntries(Object.keys(candidate.metrics).map((key) => [key, candidate.metrics[key] - baseline.metrics[key]]));
const checks = {
  hitAbsolute: candidate.metrics.hitRateAt5 >= thresholds.candidateHitRateAt5Min,
  hitDelta: delta.hitRateAt5 >= thresholds.candidateHitRateAt5VsBaselineMinDelta,
  recallDelta: delta.recallAt5 >= thresholds.candidateRecallAt5VsBaselineMinDelta,
  mrrDelta: delta.mrrAt5 >= thresholds.candidateMrrAt5VsBaselineMinDelta,
  ndcgDelta: delta.ndcgAt5 >= thresholds.candidateNdcgAt5VsBaselineMinDelta,
  hardNegativeAbsolute: candidate.metrics.hardNegativeQueryRateAt5 <= thresholds.candidateHardNegativeRateAt5Max,
  hardNegativeDelta: delta.hardNegativeQueryRateAt5 <= thresholds.candidateHardNegativeRateAt5VsBaselineMaxDelta,
  noAnswerFalsePositiveAbsolute: candidate.metrics.noAnswerFalsePositiveRateAt5 <= thresholds.candidateNoAnswerFalsePositiveRateAt5Max,
  noAnswerFalsePositiveDelta: delta.noAnswerFalsePositiveRateAt5 <= thresholds.candidateNoAnswerFalsePositiveRateAt5VsBaselineMaxDelta,
  meanLatencyRatio: candidate.meanQueryLatencyMs / baseline.meanQueryLatencyMs <= thresholds.candidateMeanLatencyVsBaselineMaxRatio,
  p95LatencyRatio: candidate.p95QueryLatencyMs / baseline.p95QueryLatencyMs <= thresholds.candidateP95LatencyVsBaselineMaxRatio
};
const artifact = { schemaVersion: 1, generatedAt: new Date().toISOString(), qrelsPath, benchmarkSha256: sha256(qrelsPath), benchmarkCounts: { positiveQueries: queries.length, noAnswerQueries: noAnswerQueries.length, qrels: queries.reduce((n,q)=>n+q.relevantSources.length,0), hardNegativeJudgments: queries.reduce((n,q)=>n+q.hardNegativeSources.length,0) }, thresholds, indexEvidence: { baseline: { path: baselineIndex, sha256: sha256(baselineIndex), bytes: statSync(baselineIndex).size }, candidate: { path: candidateIndex, sha256: sha256(candidateIndex), bytes: statSync(candidateIndex).size } }, qrels: queries.flatMap((q)=>q.relevantSources.map((sourceId)=>({queryId:q.queryId,sourceId,grade:3}))), queries, noAnswerQueries, arms:[baseline,candidate], delta, checks, passed:Object.values(checks).every(Boolean) };
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
for (const arm of artifact.arms) writeFileSync(outputPath.replace(/\.json$/, `-${arm.name}-eval-input.json`), JSON.stringify({ k, metadata: { arm: arm.name, indexPath: arm.indexPath, model: arm.model }, qrels: artifact.qrels, run: arm.run.map(({queryId,sourceId,rank,score})=>({queryId,sourceId,rank,score})) }, null, 2));
console.log(JSON.stringify({ outputPath, benchmarkSha256: artifact.benchmarkSha256, benchmarkCounts: artifact.benchmarkCounts, arms: artifact.arms.map(({name,metrics,elapsedMs,meanQueryLatencyMs,p95QueryLatencyMs})=>({name,metrics,elapsedMs,meanQueryLatencyMs,p95QueryLatencyMs})), delta, checks, passed:artifact.passed }, null, 2));
