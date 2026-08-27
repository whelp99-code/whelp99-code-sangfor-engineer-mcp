import { createHash } from 'node:crypto';
import {
  IndexPromotionReportInputSchema,
  IndexPromotionReportSchema,
  PromotionCurrentStateSchema,
  type IndexPromotionReport,
  type IndexPromotionReportInput,
  type PromotionEvaluation,
} from './index-promotion-types.js';

export class IndexPromotionReportError extends Error {
  readonly name = 'IndexPromotionReportError';
  constructor(readonly code: string, detail?: string, options?: ErrorOptions) {
    super(detail === undefined ? code : `${code}: ${detail}`, options);
  }
}

export function canonicalPromotionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPromotionJson).join(',')}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPromotionJson(entry)}`).join(',')}}`;
}

export function promotionReportDigest(input: IndexPromotionReportInput): string {
  return createHash('sha256').update(canonicalPromotionJson(input)).digest('hex');
}

export function sealIndexPromotionReport(raw: unknown): IndexPromotionReport {
  const parsed = IndexPromotionReportInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IndexPromotionReportError('PROMOTION_REPORT_INVALID', parsed.error.issues[0]?.path.join('.') ?? 'unknown', { cause: parsed.error });
  }
  return IndexPromotionReportSchema.parse({ ...parsed.data, reportDigest: promotionReportDigest(parsed.data) });
}

export function parseIndexPromotionReport(raw: unknown): IndexPromotionReport {
  const parsed = IndexPromotionReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IndexPromotionReportError('PROMOTION_REPORT_INVALID', parsed.error.issues[0]?.path.join('.') ?? 'unknown', { cause: parsed.error });
  }
  return parsed.data;
}

function mismatchReason(report: IndexPromotionReport, currentRaw: unknown): string | undefined {
  const current = PromotionCurrentStateSchema.safeParse(currentRaw);
  if (!current.success) return 'PROMOTION_CURRENT_STATE_INVALID';
  if (report.tenantId !== current.data.tenantId || report.projectId !== current.data.projectId) return 'PROMOTION_SCOPE_MISMATCH';
  if (report.cohortId !== current.data.cohortId || report.indexEpoch !== current.data.indexEpoch) return 'PROMOTION_COHORT_MISMATCH';
  if (report.corpusDigest !== current.data.corpusDigest) return 'PROMOTION_CORPUS_MISMATCH';
  if (report.extensionName !== current.data.extensionName || report.extensionVersion !== current.data.extensionVersion) return 'PROMOTION_EXTENSION_UNSUPPORTED';
  if (report.indexName !== current.data.indexName || report.indexIdentity !== current.data.indexIdentity) return 'PROMOTION_INDEX_MISMATCH';
  if (report.candidateRowCount !== current.data.candidateRowCount) return 'PROMOTION_ROW_COUNT_MISMATCH';
  return undefined;
}

export function evaluateIndexPromotion(raw: unknown, current: unknown, now: Date): PromotionEvaluation {
  const parsed = IndexPromotionReportSchema.safeParse(raw);
  if (!parsed.success) return { eligible: false, reason: 'PROMOTION_REPORT_INVALID' };
  const { reportDigest, ...input } = parsed.data;
  if (promotionReportDigest(input) !== reportDigest) return { eligible: false, reason: 'PROMOTION_REPORT_DIGEST_MISMATCH' };
  if (parsed.data.extensionName !== 'vector' || parsed.data.extensionVersion !== '0.8.1') return { eligible: false, reason: 'PROMOTION_EXTENSION_UNSUPPORTED' };
  const mismatch = mismatchReason(parsed.data, current);
  if (mismatch) return { eligible: false, reason: mismatch };
  const ageMilliseconds = now.getTime() - Date.parse(parsed.data.measuredAt);
  if (!Number.isFinite(ageMilliseconds) || ageMilliseconds < 0 || ageMilliseconds > parsed.data.maxAgeSeconds * 1000) return { eligible: false, reason: 'PROMOTION_REPORT_STALE' };
  if (parsed.data.recallAtK < 0.99) return { eligible: false, reason: 'PROMOTION_RECALL_LOW' };
  if (parsed.data.candidateP95Ms > 100 && parsed.data.candidateP95Ms > parsed.data.exactP95Ms * 0.8) return { eligible: false, reason: 'PROMOTION_LATENCY_HIGH' };
  if (parsed.data.recoveryRate !== 1) return { eligible: false, reason: 'PROMOTION_RECOVERY_FAILED' };
  if (parsed.data.updateRate !== 1) return { eligible: false, reason: 'PROMOTION_UPDATE_FAILED' };
  if (!parsed.data.scopeIsolationProof) return { eligible: false, reason: 'PROMOTION_SCOPE_ISOLATION_FAILED' };
  return { eligible: true, reason: 'PROMOTION_ELIGIBLE' };
}
