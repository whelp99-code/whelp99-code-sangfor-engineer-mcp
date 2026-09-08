import { readFileSync } from 'node:fs';
import { computeRetrievalMetrics } from '../packages/sangfor-rag/src/retrieval-eval.js';
import {
  parseBoundaryRagEvalInputV1,
  type RagEvalInput,
} from './lib/rag-eval-runtime-boundary.js';

function parseJsonFile(path: string): RagEvalInput {
  return parseBoundaryRagEvalInputV1(readFileSync(path, 'utf8'));
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: pnpm tsx scripts/rag-eval-run.ts <eval-input.json>');
  }
  const input = parseJsonFile(inputPath);
  const k = input.k ?? 10;
  const metrics = computeRetrievalMetrics(input.qrels, input.run, k);
  console.log(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    k,
    metadata: input.metadata ?? {},
    metrics,
  }, null, 2));
}

main();
