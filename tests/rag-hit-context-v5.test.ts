import { expect, it } from 'vitest';
import { attachHitContext } from '../packages/sangfor-rag/src/hit-context.js';
import type { RagSearchHit } from '../packages/sangfor-rag/src/rag-types.js';
const base: RagSearchHit = { id: 'hit', filePath: 'manual.md', product: 'HCI', version: '6.11.3', title: 'Guide', text: 'Caution', contentHash: 'a', vector: [], sourceType: 'manual', trustLevel: 'official', score: 1, cosineScore: 0, vectorScoreUsed: false, retrievalMode: 'bm25', keywordScore: 1 };
it('adds neighboring evidence in document order without changing the selected hit', () => {
  const after = { ...base, id: 'next', text: '1. Open settings. 2. Save.', contentHash: 'b' };
  const result = attachHitContext([base], [base, after], 1)[0];
  expect(result.id).toBe('hit'); expect(result.text).toBe('Caution'); expect(result.vector).toEqual([]);
  expect(result.contextChunks?.map((c) => c.text)).toEqual(['Caution', after.text]);
  expect(result.contextChunks?.some((c) => 'vector' in c)).toBe(false);
});
it('cannot attach other tenant, release, trust, or actor data at the same path', () => {
  const candidates = [base, { ...base, id: 'tenant', tenantId: 'private' }, { ...base, id: 'version', version: '6.2.0' },
    { ...base, id: 'customer', trustLevel: 'customer' as const }, { ...base, id: 'actor', aclActorIds: ['other'] }];
  expect(attachHitContext([base], candidates, 2)[0].contextChunks?.map((c) => c.id)).toEqual(['hit']);
  expect(() => attachHitContext([base], [], 1)).toThrow('RAG_CONTEXT_HIT_NOT_AUTHORIZED');
});
it('bounds the wire context without cutting a source sentence', () => {
  const large = { ...base, id: 'large', text: 'x'.repeat(9000) };
  expect(attachHitContext([base], [base, large], 1)[0].contextChunks?.map((c) => c.id)).toEqual(['hit']);
  expect(() => attachHitContext([base], [base], 3)).toThrow('RAG_CONTEXT_NEIGHBORS_INVALID');
});

import { retrievalBody } from '../packages/sangfor-rag/src/retrieval-text.js';
import { rankHybrid } from '../packages/sangfor-rag/src/rag-ranking.js';
it('does not let repeated headings replace real body evidence', () => {
  const title = 'High Availability / Link Aggregation';
  const short = { ...base, id: 'short', title, text: `# ${title}\n\nDevices must use the same model.` };
  const relevant = { ...base, id: 'relevant', title, text: `# ${title}\n\nEnable link aggregation and select the LAN and WAN interfaces.` };
  const ranked = rankHybrid([short, relevant], [], 'enable link aggregation').sort((a, b) => b.score - a.score);
  expect(ranked[0].id).toBe('relevant');
  expect(retrievalBody(`# ${title}\n\nSteps`, title)).toBe('Steps');
  expect(retrievalBody('```\n# Example\n```', 'Example')).toBe('```\n# Example\n```');
});
