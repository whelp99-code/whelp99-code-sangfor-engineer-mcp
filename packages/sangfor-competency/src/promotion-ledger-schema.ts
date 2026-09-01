import { z } from 'zod';
import { checkpointHashSchema } from './promotion-checkpoint.js';
import { capabilityTargetSchema, evidenceIdSchema, sha256Schema, timestampSchema, type CapabilityTarget } from './evidence-primitives.js';
import { MATURITIES, MATURITY_RANK, type Maturity } from './schema.js';

const staleInvalidationSchema = z.object({
  reason: z.enum(['evidence_expired', 'identity_drift']),
  observedIdentityRef: sha256Schema,
}).strict().readonly();
const promotionLedgerEventFields = {
  version: z.literal(1), seq: z.number().int().nonnegative(), eventId: evidenceIdSchema, at: timestampSchema,
  outcome: z.enum(['applied', 'rejected']), action: z.enum(['promote', 'emergency_demote', 'stale', 'reject']),
  target: capabilityTargetSchema, fromMaturity: z.enum(MATURITIES), toMaturity: z.enum(MATURITIES),
  decisionRef: sha256Schema, manifestRef: sha256Schema, nonceRef: sha256Schema.nullable(),
  refusalCode: evidenceIdSchema.nullable(), invalidation: staleInvalidationSchema.optional(), prevHash: checkpointHashSchema,
} as const;
const refineInvalidation = (event: {
  readonly action: string;
  readonly outcome: string;
  readonly fromMaturity: Maturity;
  readonly toMaturity: Maturity;
  readonly nonceRef: string | null;
  readonly refusalCode: string | null;
  readonly invalidation?: unknown;
}, context: z.RefinementCtx): void => {
  if ((event.action === 'stale') !== (event.invalidation !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['invalidation'], message: 'invalidation is required only for stale events' });
  }
  if (event.action === 'stale' && (event.outcome !== 'applied' || event.nonceRef !== null || event.refusalCode !== null
    || MATURITY_RANK[event.toMaturity] > MATURITY_RANK.tested_mock
    || MATURITY_RANK[event.toMaturity] > MATURITY_RANK[event.fromMaturity])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'stale events are conservative nonce-free applied invalidations' });
  }
};
const unsignedEventSchema = z.object(promotionLedgerEventFields).strict().superRefine(refineInvalidation).readonly();
const eventSchema = z.object({ ...promotionLedgerEventFields, hash: sha256Schema }).strict().superRefine(refineInvalidation).readonly();

export type PromotionLedgerEvent = z.infer<typeof eventSchema>;
type PromotionLedgerEventInputBase = {
  readonly version: 1;
  readonly eventId: string;
  readonly at: string;
  readonly outcome: 'applied' | 'rejected';
  readonly target: CapabilityTarget;
  readonly fromMaturity: Maturity;
  readonly toMaturity: Maturity;
  readonly decisionRef: string;
  readonly manifestRef: string;
  readonly nonceRef: string | null;
  readonly refusalCode: string | null;
};
export type PromotionLedgerEventInput = PromotionLedgerEventInputBase & (
  | { readonly action: 'promote' | 'emergency_demote' | 'reject'; readonly invalidation?: never }
  | { readonly action: 'stale'; readonly invalidation: { readonly reason: 'evidence_expired' | 'identity_drift'; readonly observedIdentityRef: string } }
);

export const parsePromotionLedgerEvent = (value: unknown): PromotionLedgerEvent => eventSchema.parse(value);
export const parseUnsignedPromotionLedgerEvent = (value: unknown) => unsignedEventSchema.parse(value);
