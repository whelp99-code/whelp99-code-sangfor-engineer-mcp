import { z } from 'zod';
import {
  IndexPromotionEvidenceSchema,
  type IndexPromotionEvidence,
  type VerificationAuthority,
  verifyIndexPromotionEvidence,
} from './index-promotion-authority.js';
import { canonicalPromotionJson } from './index-promotion-evaluator.js';
import type { PgvectorScope, PgvectorSqlExecutor } from './pgvector-types.js';

const HistoryRowSchema = z.object({
  nonce: z.string(), cohortId: z.string(), indexEpoch: z.number().int(), authorityActorId: z.string(),
  evidence: z.unknown(), evidenceCanonical: z.string(), reportDigest: z.string(),
}).strict();
const PromotionEvidenceRowSchema = z.object({ report: z.unknown() }).strict();
const InsertedRowSchema = z.object({ nonce: z.string() }).strict();

type HistoryRow = z.infer<typeof HistoryRowSchema>;

export class IndexPromotionHistoryError extends Error {
  readonly name = 'IndexPromotionHistoryError';
  constructor(readonly code: string, detail?: string, options?: ErrorOptions) {
    super(detail === undefined ? code : `${code}: ${detail}`, options);
  }
}

function parseHistoryRow(
  row: HistoryRow,
  authority: VerificationAuthority,
): IndexPromotionEvidence {
  const parsed = IndexPromotionEvidenceSchema.safeParse(row.evidence);
  if (!parsed.success) {
    throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_HISTORY_CORRUPT', row.nonce, { cause: parsed.error });
  }
  const evidence = parsed.data;
  if (row.nonce !== evidence.nonce || row.cohortId !== evidence.report.cohortId
    || row.indexEpoch !== evidence.report.indexEpoch || row.authorityActorId !== evidence.authorityActorId
    || row.evidenceCanonical !== canonicalPromotionJson(evidence)
    || row.reportDigest !== evidence.report.reportDigest) {
    throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_HISTORY_CORRUPT', row.nonce);
  }
  try {
    verifyIndexPromotionEvidence(evidence, authority);
  } catch (error) {
    throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_HISTORY_CORRUPT', row.nonce, { cause: error });
  }
  return evidence;
}

async function verifiedHistory(
  transaction: PgvectorSqlExecutor,
  scope: PgvectorScope,
  authority: VerificationAuthority,
): Promise<ReadonlyMap<string, IndexPromotionEvidence>> {
  const rows = z.array(HistoryRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
    SELECT "nonce","cohortId","indexEpoch","authorityActorId","evidence","evidenceCanonical","reportDigest"
    FROM "BlroRagIndexPromotionEvidence" WHERE "tenantId"=$1 AND "projectId"=$2
    ORDER BY "createdAt","nonce"`, scope.tenantId, scope.projectId));
  return new Map(rows.map((row) => [row.nonce, parseHistoryRow(row, authority)]));
}

async function assertPromotionRowsRetained(
  transaction: PgvectorSqlExecutor,
  scope: PgvectorScope,
  history: ReadonlyMap<string, IndexPromotionEvidence>,
): Promise<void> {
  const promotions = z.array(PromotionEvidenceRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
    SELECT "report" FROM "BlroRagIndexPromotion" WHERE "tenantId"=$1 AND "projectId"=$2`,
  scope.tenantId, scope.projectId));
  for (const row of promotions) {
    const parsed = IndexPromotionEvidenceSchema.safeParse(row.report);
    const retained = parsed.success ? history.get(parsed.data.nonce) : undefined;
    if (!parsed.success || !retained || canonicalPromotionJson(retained) !== canonicalPromotionJson(parsed.data)) {
      throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_HISTORY_MISSING', scope.projectId);
    }
  }
}

export async function requirePromotionEvidenceHistory(
  transaction: PgvectorSqlExecutor,
  scope: PgvectorScope,
  evidence: IndexPromotionEvidence,
  authority: VerificationAuthority,
): Promise<void> {
  const history = await verifiedHistory(transaction, scope, authority);
  await assertPromotionRowsRetained(transaction, scope, history);
  const retained = history.get(evidence.nonce);
  if (!retained || canonicalPromotionJson(retained) !== canonicalPromotionJson(evidence)) {
    throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_HISTORY_MISSING', evidence.nonce);
  }
}

export async function appendPromotionEvidenceHistory(
  transaction: PgvectorSqlExecutor,
  scope: PgvectorScope,
  evidence: IndexPromotionEvidence,
  authority: VerificationAuthority,
): Promise<void> {
  const history = await verifiedHistory(transaction, scope, authority);
  await assertPromotionRowsRetained(transaction, scope, history);
  const inserted = z.array(InsertedRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
    INSERT INTO "BlroRagIndexPromotionEvidence"
      ("tenantId","projectId","nonce","cohortId","indexEpoch","authorityActorId","evidence","evidenceCanonical","reportDigest")
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    ON CONFLICT ("tenantId","projectId","nonce") DO NOTHING RETURNING "nonce"`,
  scope.tenantId, scope.projectId, evidence.nonce, evidence.report.cohortId, evidence.report.indexEpoch,
  evidence.authorityActorId, canonicalPromotionJson(evidence), canonicalPromotionJson(evidence),
  evidence.report.reportDigest));
  if (inserted.length !== 1) throw new IndexPromotionHistoryError('PROMOTION_EVIDENCE_REPLAY', evidence.nonce);
}
