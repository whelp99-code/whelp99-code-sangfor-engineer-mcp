import { describe, expect, it } from 'vitest';
import { querySubjectTerms, subjectMatchCount } from '../packages/sangfor-rag/src/query-evidence.js';

describe('query subject evidence', () => {
  it('does not treat shared request words or version as subject evidence', () => {
    expect(subjectMatchCount('HCI 6.11.3 phonon configuration', 'HCI 6.11.3 network configuration')).toBe(0);
    expect(querySubjectTerms('HCI 6.11.3 configuration')).toEqual([]);
  });
  it('retains technical identifiers and normalizes technical plurals', () => {
    expect(subjectMatchCount('How do I configure static routes?', 'Configure a static route using eth0.')).toBe(2);
    expect(querySubjectTerms('configure /etc/hosts eth0 -v')).toEqual(['/etc/hosts', 'eth0', '-v']);
  });
  it('requires token support rather than substring collisions', () => {
    expect(subjectMatchCount('ntp', 'snTpClient configuration')).toBe(0);
    expect(subjectMatchCount('NTP key 설정 방법', 'NTP key configuration')).toBe(2);
  });
});

import { afterEach, vi } from 'vitest';
import { hasRetrievalEvidence, rankHybrid } from '../packages/sangfor-rag/src/rag-ranking.js';
import type { RagDocumentChunk } from '../packages/sangfor-rag/src/rag-types.js';
afterEach(() => vi.unstubAllEnvs());
it('filters unsupported subjects in the real ranker without changing supported ranking', () => {
  vi.stubEnv('SANGFOR_RAG_REQUIRE_SUBJECT_MATCH', '1');
  const chunk: RagDocumentChunk = { id: 'one', filePath: 'manual.md', title: 'Network configuration',
    text: 'Configure a static route on eth0.', product: 'HCI', sourceType: 'manual', trustLevel: 'official',
    section: 'network', contentHash: 'test', vector: [] };
  const absent = rankHybrid([chunk], [], 'phonon configuration').filter(hasRetrievalEvidence);
  expect(absent).toEqual([]);
  const present = rankHybrid([chunk], [], 'configure static routes').filter(hasRetrievalEvidence);
  expect(present.map((row) => row.id)).toEqual(['one']);
  expect(hasRetrievalEvidence({ keywordScore: 0, cosineScore: 0.99, retrievalMode: 'hybrid-semantic', subjectScore: 0 })).toBe(false);
});
