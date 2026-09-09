import type { RagDocumentChunk, RagSearchHit } from './rag-types.js';
export type RagContextChunk = Pick<RagDocumentChunk, 'id' | 'filePath' | 'product' | 'version' | 'title' | 'text' | 'contentHash'>;

/** Caller supplies already-authorized candidates; never loads an unfiltered index. */
export function attachHitContext(hits: readonly RagSearchHit[], candidates: readonly RagDocumentChunk[], neighbors = 0): RagSearchHit[] {
  if (!Number.isInteger(neighbors) || neighbors < 0 || neighbors > 2) throw new Error('RAG_CONTEXT_NEIGHBORS_INVALID');
  if (!neighbors) return [...hits];
  return hits.map((hit) => {
    const sameDocument = candidates.filter((c) => c.filePath === hit.filePath && c.product === hit.product && c.version === hit.version
      && c.tenantId === hit.tenantId && c.projectId === hit.projectId && c.trustLevel === hit.trustLevel && c.sourceType === hit.sourceType
      && c.title === hit.title && JSON.stringify(c.aclActorIds) === JSON.stringify(hit.aclActorIds));
    const position = sameDocument.findIndex((c) => c.id === hit.id);
    if (position < 0) throw new Error('RAG_CONTEXT_HIT_NOT_AUTHORIZED');
    const selected = new Set<number>();
    let chars = 0;
    // Prefer the hit, then closest neighbors. The wire budget never truncates a quotation.
    for (let distance = 0; distance <= neighbors; distance++) {
      for (const index of distance ? [position - distance, position + distance] : [position]) {
        const chunk = sameDocument[index];
        if (!chunk || chars + chunk.text.length > 8000) continue;
        selected.add(index); chars += chunk.text.length;
      }
    }
    const contextChunks = [...selected].sort((a, b) => a - b).map((index): RagContextChunk => {
      const { id, filePath, product, version, title, text, contentHash } = sameDocument[index];
      return { id, filePath, product, version, title, text, contentHash };
    });
    return { ...hit, contextChunks };
  });
}
