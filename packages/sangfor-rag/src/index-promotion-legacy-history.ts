/** Legacy signed envelopes are verifiable audit history, never current promotion authority. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IndexPromotionEvidenceSchema, verifyIndexPromotionEvidence, type VerificationAuthority } from './index-promotion-authority.js';
import { IndexPromotionReportSchema } from './index-promotion-types.js';
import { canonicalPromotionJson } from './index-promotion-evaluator.js';

const LegacyReportSchema = IndexPromotionReportSchema.unwrap().omit({
  embeddingSpaceDigest: true, benchmarkDigest: true, benchmarkProfileDigest: true,
  benchmarkQueryCount: true, k: true, recoveryMeasured: true, updateMeasured: true,
}).strict();
const LegacyEvidenceSchema = IndexPromotionEvidenceSchema.unwrap().extend({ report: LegacyReportSchema }).strict();
const HistoricalEvidenceSchema = z.union([IndexPromotionEvidenceSchema, LegacyEvidenceSchema]);
export type HistoricalPromotionEvidence = z.infer<typeof HistoricalEvidenceSchema>;

export function parseHistoricalPromotionEvidence(raw: unknown): HistoricalPromotionEvidence {
  return HistoricalEvidenceSchema.parse(raw);
}

export function verifyHistoricalPromotionEvidence(raw: unknown, authority: VerificationAuthority): HistoricalPromotionEvidence {
  const evidence = parseHistoricalPromotionEvidence(raw);
  if (evidence.tenantId !== authority.tenantId || evidence.projectId !== authority.projectId
    || evidence.report.tenantId !== authority.tenantId || evidence.report.projectId !== authority.projectId
    || evidence.authorityActorId !== authority.authorityActorId) throw new Error('PROMOTION_HISTORY_SCOPE_MISMATCH');
  const { reportDigest: retainedDigest, ...retainedReport } = evidence.report;
  if (retainedDigest !== createHash('sha256').update(canonicalPromotionJson(retainedReport)).digest('hex')) {
    throw new Error('PROMOTION_HISTORY_REPORT_DIGEST_INVALID');
  }
  const current = IndexPromotionEvidenceSchema.safeParse(evidence);
  if (current.success) {
    verifyIndexPromotionEvidence(current.data, authority);
    return current.data;
  }
  const legacy = LegacyEvidenceSchema.parse(evidence);
  const { reportDigest, ...reportInput } = legacy.report;
  const digest = (value: unknown) => createHash('sha256').update(canonicalPromotionJson(value)).digest('hex');
  if (reportDigest !== digest(reportInput) || legacy.evidenceDigest !== digest(legacy.report)) {
    throw new Error('PROMOTION_LEGACY_HISTORY_DIGEST_INVALID');
  }
  const { signature, ...unsigned } = legacy;
  const expected = createHmac('sha256', z.string().min(32).parse(authority.secret))
    .update(`sangfor.rag-index-promotion-evidence.v1\n${canonicalPromotionJson(unsigned)}`).digest();
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('PROMOTION_LEGACY_HISTORY_SIGNATURE_INVALID');
  return legacy;
}
