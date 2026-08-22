#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';

const outputPath = process.argv[2] ?? 'data/evals/issue-14/ab-evaluation.json';
const baselineIndex = process.argv[3] ?? 'data/rag/index.json';
const candidateIndex = process.argv[4] ?? 'data/evals/issue-14/e5-single-profile-index.json';
const k = 5;

const queries = [
  ['q01', 'Agentless Backup third-party integration SFVDDK APIs', 'HCI_SCP', 45, 1388, 2655992],
  ['q02', 'Enable the Agentless Backup service port when connecting through SCP', 'HCI_SCP', 45, 1388, 2655987],
  ['q03', 'Agentless Backup OpenAPI asynchronous task mechanism', 'HCI_SCP', 45, 1388, 2655994],
  ['q04', 'Platform connection authentication and authorization for Agentless Backup', 'HCI_SCP', 45, 1388, 2655997],
  ['q05', 'Add virtual machines to an Agentless Backup policy by API', 'HCI_SCP', 45, 1388, 2655999],
  ['q06', 'Recover an Agentless Backup to a new virtual machine', 'HCI_SCP', 45, 1388, 2656002],
  ['q07', 'Differentially recover an Agentless Backup to the original VM', 'HCI_SCP', 45, 1388, 2656004],
  ['q08', 'Rapid recovery procedure for Agentless Backup', 'HCI_SCP', 45, 1388, 2656005],
  ['q09', 'Generate an API key for NetBackup and the XBSA application', 'HCI_SCP', 45, 1388, 2656029],
  ['q10', 'HCI 6.11.3 Sangfor CLI daily operation and maintenance module', 'HCI_SCP', 10, 1381, 2654470],
  ['q11', 'HCI 6.11.3 command line instructions for operations management', 'HCI_SCP', 10, 1381, 2662960],
  ['q12', 'SCP 6.12.0 Sangfor CLI operation and maintenance guidelines', 'HCI_SCP', 45, 1388, 2656819],
].map(([queryId, query, product, productId, versionId, categoryId]) => ({
  queryId,
  query,
  product,
  relevantSources: [
    `data/sources/raw/support_${productId}_${versionId}_${categoryId}.md`,
    `data/sources/raw/hci-scp-api-cli/hci_scp_${productId}_${versionId}_${categoryId}.md`,
  ],
}));

function dcg(grades) {
  return grades.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
}

function metrics(run) {
  let hit = 0;
  let recall = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  for (const query of queries) {
    const relevant = new Set(query.relevantSources);
    const seen = new Set();
    const ranked = run.filter((row) => {
      if (row.queryId !== query.queryId || seen.has(row.sourceId)) return false;
      seen.add(row.sourceId);
      return true;
    }).slice(0, k);
    const grades = ranked.map((row) => relevant.has(row.sourceId) ? 3 : 0);
    const found = grades.filter((grade) => grade > 0).length;
    const first = grades.findIndex((grade) => grade > 0);
    hit += found > 0 ? 1 : 0;
    recall += found / relevant.size;
    reciprocalRank += first >= 0 ? 1 / (first + 1) : 0;
    ndcg += dcg(grades) / dcg([3, 3]);
  }
  const count = queries.length;
  return {
    queryCount: count,
    hitRateAt5: hit / count,
    recallAt5: recall / count,
    mrrAt5: reciprocalRank / count,
    ndcgAt5: ndcg / count,
  };
}

async function runArm({ name, indexPath, baseUrl, model }) {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/mcp-server/src/index.ts'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MCP_PROBE: '1',
      SANGFOR_SEARCH_GAP_CAPTURE: '0',
      SANGFOR_RAPID_MLX_BASE_URL: baseUrl,
      SANGFOR_RAPID_MLX_EMBEDDING_MODEL: model,
      SANGFOR_RAPID_MLX_BATCH_SIZE: '64',
    },
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const started = performance.now();
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: `issue-14-${name}`, version: '1.0' },
  });
  const run = [];
  const latenciesMs = [];
  let diagnostics;
  try {
    for (const query of queries) {
      const queryStarted = performance.now();
      const result = await rpc('tools/call', {
        name: 'sangfor_rag_search',
        arguments: { query: query.query, product: query.product, limit: k, indexPath, privacy_mode: 'raw' },
      });
      latenciesMs.push(performance.now() - queryStarted);
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} MCP search failed`);
      const hits = result.structuredContent;
      if (!Array.isArray(hits)) throw new Error(`${name} MCP returned a non-array raw result`);
      hits.forEach((entry, index) => run.push({
        queryId: query.queryId,
        sourceId: entry.filePath,
        rank: index + 1,
        score: entry.score,
        title: entry.title,
      }));
    }
    const summary = await rpc('tools/call', {
      name: 'sangfor_rag_index_summary',
      arguments: { indexPath },
    });
    diagnostics = summary.structuredContent;
  } finally {
    child.kill();
  }
  const elapsedMs = performance.now() - started;
  return {
    name,
    indexPath,
    baseUrl,
    model,
    queryCount: queries.length,
    elapsedMs,
    meanQueryLatencyMs: latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length,
    p95QueryLatencyMs: [...latenciesMs].sort((a, b) => a - b)[Math.ceil(latenciesMs.length * 0.95) - 1],
    metrics: metrics(run),
    diagnostics,
    run,
  };
}

const baseline = await runArm({
  name: 'current-mixed-minilm-query',
  indexPath: baselineIndex,
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
});
const candidate = await runArm({
  name: 'e5-small-single-profile',
  indexPath: candidateIndex,
  baseUrl: 'http://127.0.0.1:8001/v1',
  model: 'intfloat/multilingual-e5-small',
});

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  k,
  qrels: queries.flatMap((query) => query.relevantSources.map((sourceId) => ({ queryId: query.queryId, sourceId, grade: 3 }))),
  queries,
  arms: [baseline, candidate],
  delta: Object.fromEntries(Object.keys(candidate.metrics).map((key) => [key, candidate.metrics[key] - baseline.metrics[key]])),
};
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
for (const arm of artifact.arms) {
  const evalInputPath = outputPath.replace(/\.json$/, `-${arm.name}-eval-input.json`);
  writeFileSync(evalInputPath, JSON.stringify({
    k,
    metadata: { arm: arm.name, indexPath: arm.indexPath, model: arm.model },
    qrels: artifact.qrels,
    run: arm.run.map(({ queryId, sourceId, rank, score }) => ({ queryId, sourceId, rank, score })),
  }, null, 2));
}
console.log(JSON.stringify({ outputPath, arms: artifact.arms.map(({ name, metrics, elapsedMs, meanQueryLatencyMs, p95QueryLatencyMs, diagnostics }) => ({ name, metrics, elapsedMs, meanQueryLatencyMs, p95QueryLatencyMs, diagnostics })), delta: artifact.delta }, null, 2));
