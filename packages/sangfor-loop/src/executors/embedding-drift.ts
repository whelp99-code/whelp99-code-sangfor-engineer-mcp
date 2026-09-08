import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolveRepoData, writeFileAtomicSync } from '../../../shared/src/index.js';
import { parseBoundaryLoopEmbeddingIndexV1 } from '../runtime-boundaries.js';

// P2 — detect embedding-model drift: chunks embedded with a model other than
// the currently configured one make query and index vectors incomparable
// (search silently degrades). Detection writes a flag for scripts/rag-reembed;
// it never re-embeds by itself — that is expensive, provider-dependent work
// gated behind SANGFOR_LOOP_AUTO_REEMBED=1 in scripts/loop-tick.ts.

export const EMBEDDING_DRIFT_INDEX = () => resolveRepoData('data/rag/index.json', 'SANGFOR_RAG_INDEX_PATH');
export const EMBEDDING_DRIFT_FLAG = () => resolveRepoData('data/runtime/needs-reembed.flag', 'SANGFOR_REEMBED_FLAG_PATH');

export interface MinimalIndexChunk { embeddingModel?: string }

export function runEmbeddingDriftExecutor(input: { indexPath?: string; flagPath?: string; configuredModel: string }): { detail: string; drift: boolean } {
  const indexPath = input.indexPath ?? EMBEDDING_DRIFT_INDEX();
  const flagPath = input.flagPath ?? EMBEDDING_DRIFT_FLAG();
  if (!existsSync(indexPath)) return { detail: 'no rag index — nothing to compare', drift: false };
  const { chunks } = parseBoundaryLoopEmbeddingIndexV1(readFileSync(indexPath, 'utf8'));
  const models = [...new Set(chunks.map((c) => c.embeddingModel ?? 'hash'))].sort();
  const driftModels = models.filter((m) => m !== input.configuredModel);
  if (chunks.length > 0 && driftModels.length > 0) {
    writeFileAtomicSync(
      flagPath,
      `${new Date().toISOString()} embedding-drift index=[${models.join(',')}] configured=${input.configuredModel} — run: pnpm exec tsx scripts/rag-reembed.ts\n`
    );
    return { detail: `drift detected: index models [${models.join(',')}] != configured '${input.configuredModel}' — flag written`, drift: true };
  }
  if (existsSync(flagPath)) rmSync(flagPath, { force: true });
  return { detail: `no drift (index models [${models.join(',')}] match configured '${input.configuredModel}')`, drift: false };
}
