import { readFileSync } from 'node:fs';
import {
  computeRetrievalMetrics,
  type RetrievalQrel,
  type RetrievalRunHit
} from '../packages/sangfor-rag/src/retrieval-eval.js';

interface EvalInput {
  qrels: RetrievalQrel[];
  run: RetrievalRunHit[];
  k?: number;
  metadata?: Record<string, string>;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQrel(value: unknown): RetrievalQrel {
  if (!isRecord(value) || typeof value.queryId !== 'string' || typeof value.sourceId !== 'string' || typeof value.grade !== 'number') {
    throw new Error('Invalid qrel entry: expected { queryId, sourceId, grade }');
  }
  return { queryId: value.queryId, sourceId: value.sourceId, grade: value.grade };
}

function parseRunHit(value: unknown): RetrievalRunHit {
  if (
    !isRecord(value)
    || typeof value.queryId !== 'string'
    || typeof value.sourceId !== 'string'
    || typeof value.rank !== 'number'
    || typeof value.score !== 'number'
  ) {
    throw new Error('Invalid run entry: expected { queryId, sourceId, rank, score }');
  }
  return { queryId: value.queryId, sourceId: value.sourceId, rank: value.rank, score: value.score };
}

function parseStringMetadata(value: unknown): Record<string, string> | undefined {
  if (typeof value === 'undefined') return undefined;
  if (!isRecord(value)) throw new Error('Invalid metadata: expected string-valued object');
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== 'string') throw new Error(`Invalid metadata.${key}: expected string`);
    return [key, entry];
  }));
}

function parseInput(value: unknown): EvalInput {
  if (!isRecord(value) || !Array.isArray(value.qrels) || !Array.isArray(value.run)) {
    throw new Error('Invalid eval input: expected { qrels: [], run: [] }');
  }
  return {
    qrels: value.qrels.map(parseQrel),
    run: value.run.map(parseRunHit),
    k: typeof value.k === 'number' ? value.k : undefined,
    metadata: parseStringMetadata(value.metadata)
  };
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: pnpm tsx scripts/rag-eval-run.ts <eval-input.json>');
  }
  const input = parseInput(parseJsonFile(inputPath));
  const k = input.k ?? 10;
  const metrics = computeRetrievalMetrics(input.qrels, input.run, k);
  console.log(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    k,
    metadata: input.metadata ?? {},
    metrics
  }, null, 2));
}

main();
