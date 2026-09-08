import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalPromotionJson } from './index-promotion-evaluator.js';
import { IndexPromotionReportSchema, type IndexPromotionReport } from './index-promotion-types.js';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const NonemptySchema = z.string().min(1);
const SecretSchema = z.string().min(32);

const UnsignedEvidenceObjectSchema = z.object({
  schemaVersion: z.literal('rag.index-promotion-evidence/1'),
  tenantId: NonemptySchema,
  projectId: NonemptySchema,
  authorityActorId: NonemptySchema,
  nonce: z.string().min(16),
  evidenceDigest: DigestSchema,
  report: IndexPromotionReportSchema,
}).strict();
const UnsignedEvidenceSchema = UnsignedEvidenceObjectSchema.readonly();

export const IndexPromotionEvidenceSchema = UnsignedEvidenceObjectSchema.extend({
  signature: DigestSchema,
}).strict().readonly();

export type IndexPromotionEvidence = z.infer<typeof IndexPromotionEvidenceSchema>;

type SealInput = {
  readonly report: IndexPromotionReport;
  readonly authorityActorId: string;
  readonly nonce: string;
  readonly secret: string;
};

export type VerificationAuthority = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly authorityActorId: string;
  readonly secret: string;
};

export class IndexPromotionEvidenceError extends Error {
  readonly name = 'IndexPromotionEvidenceError';
  constructor(readonly code: string, detail?: string, options?: ErrorOptions) {
    super(detail === undefined ? code : `${code}: ${detail}`, options);
  }
}

function evidenceDigest(report: IndexPromotionReport): string {
  return createHash('sha256').update(canonicalPromotionJson(report)).digest('hex');
}

function evidenceSignature(unsigned: z.infer<typeof UnsignedEvidenceSchema>, secret: string): string {
  return createHmac('sha256', SecretSchema.parse(secret))
    .update(`sangfor.rag-index-promotion-evidence.v1\n${canonicalPromotionJson(unsigned)}`)
    .digest('hex');
}

export function sealIndexPromotionEvidence(input: SealInput): IndexPromotionEvidence {
  const report = IndexPromotionReportSchema.parse(input.report);
  const unsigned = UnsignedEvidenceSchema.parse({
    schemaVersion: 'rag.index-promotion-evidence/1',
    tenantId: report.tenantId,
    projectId: report.projectId,
    authorityActorId: input.authorityActorId,
    nonce: input.nonce,
    evidenceDigest: evidenceDigest(report),
    report,
  });
  return IndexPromotionEvidenceSchema.parse({ ...unsigned, signature: evidenceSignature(unsigned, input.secret) });
}

export function parseIndexPromotionEvidence(raw: unknown): IndexPromotionEvidence {
  const parsed = IndexPromotionEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IndexPromotionEvidenceError(
      'PROMOTION_EVIDENCE_INVALID',
      parsed.error.issues[0]?.path.join('.') ?? 'unknown',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function verifyIndexPromotionEvidence(
  raw: unknown,
  authority: VerificationAuthority,
): IndexPromotionReport {
  let evidence: IndexPromotionEvidence;
  try {
    evidence = parseIndexPromotionEvidence(raw);
  } catch (error) {
    if (error instanceof IndexPromotionEvidenceError) throw error;
    throw new IndexPromotionEvidenceError('PROMOTION_EVIDENCE_INVALID', undefined, { cause: error });
  }
  if (evidence.tenantId !== authority.tenantId || evidence.projectId !== authority.projectId) {
    throw new IndexPromotionEvidenceError('PROMOTION_EVIDENCE_SCOPE_MISMATCH');
  }
  if (evidence.authorityActorId !== authority.authorityActorId) {
    throw new IndexPromotionEvidenceError('PROMOTION_EVIDENCE_ACTOR_MISMATCH');
  }
  if (evidence.evidenceDigest !== evidenceDigest(evidence.report)) {
    throw new IndexPromotionEvidenceError('PROMOTION_EVIDENCE_CORRUPT');
  }
  const { signature, ...unsigned } = evidence;
  const expected = Buffer.from(evidenceSignature(UnsignedEvidenceSchema.parse(unsigned), authority.secret), 'hex');
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new IndexPromotionEvidenceError('PROMOTION_EVIDENCE_SIGNATURE_INVALID');
  }
  return evidence.report;
}
