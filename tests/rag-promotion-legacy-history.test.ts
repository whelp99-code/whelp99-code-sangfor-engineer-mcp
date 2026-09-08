import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalPromotionJson } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { IndexPromotionEvidenceSchema } from '../packages/sangfor-rag/src/index-promotion-authority.js';
import { verifyHistoricalPromotionEvidence } from '../packages/sangfor-rag/src/index-promotion-legacy-history.js';
import { appendPromotionEvidenceHistory } from '../packages/sangfor-rag/src/index-promotion-history.js';
import { parsePgvectorScope } from '../packages/sangfor-rag/src/pgvector-schema.js';
import type { PgvectorSqlExecutor } from '../packages/sangfor-rag/src/pgvector-types.js';
import { sealIndexPromotionReport, indexPromotionBenchmarkProfileDigest } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { sealIndexPromotionEvidence } from '../packages/sangfor-rag/src/index-promotion-authority.js';
const authority = { tenantId: 'tenant', projectId: 'project', authorityActorId: 'actor', secret: 'test-promotion-history-secret-32-bytes' };
const sha = (value: unknown) => createHash('sha256').update(canonicalPromotionJson(value)).digest('hex');
function legacyEnvelope() {
  const input = { schemaVersion: 'rag.index-promotion/1', tenantId: 'tenant', projectId: 'project', cohortId: 'old', indexEpoch: 1,
    corpusDigest: 'a'.repeat(64), exactResultDigest: 'b'.repeat(64), candidateResultDigest: 'c'.repeat(64),
    extensionName: 'vector', extensionVersion: '0.8.1', indexName: 'BlroRagEmbedding_embedding_hnsw_idx', indexIdentity: 'd'.repeat(64),
    measuredAt: '2026-09-08T00:00:00.000Z', maxAgeSeconds: 300, recallAtK: 1, exactP95Ms: 100, candidateP95Ms: 50,
    recoveryRate: 1, updateRate: 1, scopeIsolationProof: true, candidateRowCount: 10 };
  const report = { ...input, reportDigest: sha(input) };
  const unsigned = { schemaVersion: 'rag.index-promotion-evidence/1', tenantId: 'tenant', projectId: 'project', authorityActorId: 'actor',
    nonce: 'legacy-nonce-00000001', evidenceDigest: sha(report), report };
  return { ...unsigned, signature: createHmac('sha256', authority.secret).update(`sangfor.rag-index-promotion-evidence.v1\n${canonicalPromotionJson(unsigned)}`).digest('hex') };
}
describe('legacy promotion history compatibility', () => {
  it('verifies old signed audit history but never parses it as current promotion authority', () => {
    const legacy = legacyEnvelope();
    expect(verifyHistoricalPromotionEvidence(legacy, authority)).toEqual(legacy);
    expect(IndexPromotionEvidenceSchema.safeParse(legacy).success).toBe(false);
  });
  it('refuses tampering, wrong scope, unknown fields and invalid signatures', () => {
    const legacy = legacyEnvelope();
    for (const input of [{ ...legacy, signature: '0'.repeat(64) }, { ...legacy, report: { ...legacy.report, recoveryRate: 0 } },
      { ...legacy, report: { ...legacy.report, benchmarkQueryCount: 16 } }]) {
      expect(() => verifyHistoricalPromotionEvidence(input, authority)).toThrow();
    }
    expect(() => verifyHistoricalPromotionEvidence(legacy, { ...authority, projectId: 'other' })).toThrow();
  });
  it('appends new evidence after verified old history without erasing or replaying it', async () => {
    const legacy = legacyEnvelope();
    const { reportDigest: _digest, ...oldInput } = legacy.report;
    const report = sealIndexPromotionReport({ ...oldInput, cohortId: 'new', embeddingSpaceDigest: 'e'.repeat(64),
      benchmarkDigest: 'f'.repeat(64), benchmarkProfileDigest: indexPromotionBenchmarkProfileDigest(),
      benchmarkQueryCount: 16, k: 5, recoveryMeasured: true, updateMeasured: true });
    const evidence = sealIndexPromotionEvidence({ report, authorityActorId: 'actor', secret: authority.secret, nonce: 'new-nonce-000000001' });
    const calls: string[] = [];
    const transaction: PgvectorSqlExecutor = {
      async $executeRawUnsafe() { throw new Error('no update/delete allowed'); },
      async $queryRawUnsafe<T>(sql: string) {
        calls.push(sql);
        if (sql.includes('INSERT INTO')) return [{ nonce: evidence.nonce }] as T;
        if (sql.includes('FROM "BlroRagIndexPromotionEvidence"')) return [{ nonce: legacy.nonce, cohortId: legacy.report.cohortId,
          indexEpoch: legacy.report.indexEpoch, authorityActorId: 'actor', evidence: legacy, evidenceCanonical: canonicalPromotionJson(legacy), reportDigest: legacy.report.reportDigest }] as T;
        return [{ report: legacy }] as T;
      },
    };
    await appendPromotionEvidenceHistory(transaction, parsePgvectorScope({ tenantId: 'tenant', projectId: 'project', actorId: 'actor' }), evidence, authority);
    expect(calls.filter((sql) => sql.includes('INSERT INTO'))).toHaveLength(1);
  });
});
