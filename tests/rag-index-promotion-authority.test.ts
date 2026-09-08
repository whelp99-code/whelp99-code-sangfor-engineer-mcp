import { describe, expect, it } from 'vitest';
import {
  parseIndexPromotionEvidence,
  sealIndexPromotionEvidence,
  verifyIndexPromotionEvidence,
} from '../packages/sangfor-rag/src/index-promotion-authority.js';
import { sealIndexPromotionReport } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';

const SECRET = 'rag-promotion-authority-secret-at-least-32-bytes';
const OTHER_SECRET = 'forged-rag-promotion-secret-at-least-32-bytes';
const report = sealIndexPromotionReport({
  schemaVersion: 'rag.index-promotion/1', tenantId: 'tenant-a', projectId: 'project-a',
  cohortId: 'cohort-a', indexEpoch: 34, corpusDigest: 'a'.repeat(64),
  exactResultDigest: 'b'.repeat(64), candidateResultDigest: 'c'.repeat(64),
  extensionName: 'vector', extensionVersion: '0.8.1',
  indexName: 'BlroRagEmbedding_embedding_hnsw_idx', indexIdentity: 'd'.repeat(64),
  measuredAt: '2026-08-31T12:00:00.000Z', maxAgeSeconds: 3600, recallAtK: 1,
  exactP95Ms: 120, candidateP95Ms: 80, recoveryRate: 1, updateRate: 1,
  scopeIsolationProof: true, candidateRowCount: 2_100,
});

function evidence() {
  return sealIndexPromotionEvidence({
    report, authorityActorId: 'promotion-owner', nonce: 'nonce-000000000001', secret: SECRET,
  });
}

describe('RAG index promotion authority', () => {
  it('accepts retained benchmark evidence signed by the scoped promotion authority', () => {
    // Given: signed evidence retaining the benchmark report.
    const retained = evidence();
    // When: production routing verifies it against its configured authority.
    const verified = verifyIndexPromotionEvidence(retained, {
      tenantId: 'tenant-a', projectId: 'project-a', authorityActorId: 'promotion-owner', secret: SECRET,
    });
    // Then: the exact retained report is authorized.
    expect(verified).toEqual(report);
  });

  it.each([
    ['missing evidence', undefined],
    ['caller metrics without authority', report],
    ['forged authority', sealIndexPromotionEvidence({ report, authorityActorId: 'promotion-owner', nonce: 'nonce-000000000002', secret: OTHER_SECRET })],
    ['wrong actor', { ...evidence(), authorityActorId: 'other-owner' }],
    ['wrong scope', { ...evidence(), projectId: 'project-other' }],
    ['corrupt retained report', { ...evidence(), report: { ...report, recallAtK: 0.5 } }],
  ])('fails closed for %s', (_name, raw) => {
    // Given: absent, forged, rebound, or corrupt evidence.
    // When/Then: parsing or authority verification refuses it.
    expect(() => verifyIndexPromotionEvidence(raw, {
      tenantId: 'tenant-a', projectId: 'project-a', authorityActorId: 'promotion-owner', secret: SECRET,
    })).toThrow(/PROMOTION_EVIDENCE_/u);
  });

  it('rejects malformed evidence at the file boundary', () => {
    // Given: a retained artifact with an unknown field.
    const malformed = { ...evidence(), unexpected: true };
    // When/Then: strict parsing rejects the artifact before authorization.
    expect(() => parseIndexPromotionEvidence(malformed)).toThrow(/PROMOTION_EVIDENCE_INVALID/u);
  });
});
