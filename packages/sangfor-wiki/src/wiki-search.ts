import { KnowledgeChunk, normalizeProduct } from '@sangfor/shared';
import { WIKI_CHUNKS } from './wiki-seed.js';
import { listKnowledgeCards } from './wiki-store.js';

export function searchWiki(input: { product?: string; version?: string; query?: string; limit?: number }): KnowledgeChunk[] {
  const product = normalizeProduct(input.product);
  const query = (input.query ?? '').toLowerCase();
  const cardChunks: KnowledgeChunk[] = listKnowledgeCards().map((card) => ({
    id: card.id,
    sourceType: 'wiki',
    product: card.product,
    version: card.version,
    title: card.title,
    section: card.type,
    text: [
      card.symptom,
      card.cause,
      ...card.prerequisites,
      ...card.steps,
      ...card.warnings,
      ...card.verification,
      ...card.rollback
    ].filter(Boolean).join('\n'),
    trustLevel: card.trustLevel
  }));
  return [...WIKI_CHUNKS, ...cardChunks]
    .filter(chunk => chunk.product === product)
    .map(chunk => {
      const text = `${chunk.title} ${chunk.section ?? ''} ${chunk.text}`.toLowerCase();
      const score = query.split(/\s+/).filter(Boolean).reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5)
    .map(item => item.chunk);
}
