import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBm25Scores, tokenize } from '../packages/sangfor-rag/src/bm25.js';
import { rankHybrid } from '../packages/sangfor-rag/src/rag-ranking.js';
import { retrievalAncestors } from '../packages/sangfor-rag/src/retrieval-text.js';
import type { RagDocumentChunk } from '../packages/sangfor-rag/src/rag-types.js';

afterEach(() => vi.unstubAllEnvs());
const chunk = (title: string): RagDocumentChunk => ({ id: 'a', title, text: `# ${title}\n\nConnection impact details.`,
  filePath: 'manual.md', product: 'HCI', sourceType: 'manual', trustLevel: 'official', section: '1',
  contentHash: 'unchanged', vector: [],
});

describe('optional stem and ancestor lexical profile', () => {
  it('matches English inflections only when enabled and invalidates cache across modes', () => {
    const docs = [{ id: 'a', text: 'Restarting services after upgrading.' }];
    expect(computeBm25Scores('restart service upgrade', docs).get('a')).toBe(0);
    expect(computeBm25Scores('restart service upgrade', docs, { stemming: true }).get('a')).toBeGreaterThan(0);
    expect(computeBm25Scores('restart service upgrade', docs).get('a')).toBe(0);
    expect(tokenize('restarting services')).toEqual(['restarting', 'services']);
  });
  it('does not stem switches, dotted names, paths, versions or Korean tokens', () => {
    for (const [query, body] of [['--service', '--services'], ['eth0.service', 'eth0.services'],
      ['/api/service', '/api/services'], ['6.11.3', '6.11.30'], ['설정', '설정하기']]) {
      expect(computeBm25Scores(query, [{ id: 'a', text: body }], { stemming: true }).get('a')).toBe(0);
    }
  });
  it('extracts ancestors without duplicating the document root or leaf', () => {
    expect(retrievalAncestors('Product Manual / Upgrade Overview / Service Impacts')).toBe('Upgrade Overview');
    expect(retrievalAncestors('Product Manual / Service Impacts')).toBe('');
    expect(retrievalAncestors('Service Impacts')).toBe('');
  });
  it('recovers ancestor evidence without changing stored text or counting root metadata', () => {
    const doc = chunk('Product Manual / Upgrade Overview / Impacts');
    const original = structuredClone(doc);
    vi.stubEnv('SANGFOR_RAG_LEXICAL_PROFILE', 'exact');
    expect(rankHybrid([doc], [], 'upgrade')[0].keywordScore).toBe(0);
    vi.stubEnv('SANGFOR_RAG_LEXICAL_PROFILE', 'stem-ancestors');
    expect(rankHybrid([doc], [], 'upgrade')[0].keywordScore).toBeGreaterThan(0);
    expect(rankHybrid([doc], [], 'Product Manual')[0].keywordScore).toBe(0);
    expect(doc).toEqual(original);
    doc.title = 'Product Manual / Network / Impacts';
    doc.text = `# ${doc.title}\n\nConnection impact details.`;
    expect(rankHybrid([doc], [], 'upgrade')[0].keywordScore).toBe(0);
  });
  it('rejects unknown profile names', () => {
    vi.stubEnv('SANGFOR_RAG_LEXICAL_PROFILE', 'unverified-profile');
    expect(() => rankHybrid([chunk('Manual')], [], 'upgrade')).toThrow('RAG_LEXICAL_PROFILE_INVALID');
  });
});
