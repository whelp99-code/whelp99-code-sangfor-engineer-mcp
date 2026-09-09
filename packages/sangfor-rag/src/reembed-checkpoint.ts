import type { RagDocumentChunk } from './rag-types.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';
import { resolveEmbeddingSpace, sameEmbeddingSpace } from './embedding-space.js';
const VECTOR_FIELDS = new Set(['vector', 'embeddingBackend', 'embeddingModel', 'vectorDims', 'embeddingSpace']);
function sourceMetadata(chunk: RagDocumentChunk): string {
  const entries = Object.entries(chunk).filter(([key]) => !VECTOR_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}
/** Resuming never grants a checkpoint new source scope or a different model identity. */
export function verifyReembedCheckpoint(saved: readonly RagDocumentChunk[], source: readonly RagDocumentChunk[], backend: EmbeddingBackend, model: string): void {
  if (saved.length !== source.length) throw new Error('RAG_REEMBED_CHECKPOINT_COUNT');
  saved.forEach((chunk, index) => {
    const expected = resolveEmbeddingSpace(model, chunk.vector.length, backend);
    if (sourceMetadata(chunk) !== sourceMetadata(source[index])) throw new Error('RAG_REEMBED_CHECKPOINT_SOURCE');
    if (chunk.embeddingModel !== model || chunk.embeddingBackend !== backend || chunk.vectorDims !== chunk.vector.length
      || !sameEmbeddingSpace(chunk.embeddingSpace, expected) || !chunk.vector.length
      || !chunk.vector.every(Number.isFinite) || !chunk.vector.some((v) => v !== 0)) throw new Error('RAG_REEMBED_CHECKPOINT_SPACE');
  });
}
