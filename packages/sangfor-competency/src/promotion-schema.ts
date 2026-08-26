import { z } from 'zod';
import {
  actorIdentitySchema,
  capabilityTargetSchema,
  evidenceIdSchema,
  relativeArtifactPathSchema,
  sha256Schema,
  timestampSchema,
} from './evidence-primitives.js';
import { CAPABILITY_EVIDENCE_VERSION, O5_COUNTER_KEYS, o5CampaignCountersSchema } from './evidence-schema.js';
import { MATURITIES } from './schema.js';

export const CAPABILITY_PROMOTION_VERSION = 1 as const;

export const capabilityPromotionRequestSchema = z.object({
  version: z.literal(CAPABILITY_PROMOTION_VERSION),
  requestId: evidenceIdSchema,
  manifestId: evidenceIdSchema,
  manifestDigest: sha256Schema,
  target: capabilityTargetSchema,
  fromMaturity: z.enum(MATURITIES),
  requestedMaturity: z.enum(MATURITIES),
  requestedBy: actorIdentitySchema,
  requestedAt: timestampSchema,
  evidenceRef: relativeArtifactPathSchema,
  auditRef: relativeArtifactPathSchema,
  o5Counters: o5CampaignCountersSchema,
}).strict().readonly();

const humanReviewerSchema = z.object({
  actorId: evidenceIdSchema,
  actorType: z.literal('human_pm'),
}).strict().readonly();

const promotionDecisionFields = {
  version: z.literal(CAPABILITY_PROMOTION_VERSION),
  decisionId: evidenceIdSchema,
  requestId: evidenceIdSchema,
  manifestId: evidenceIdSchema,
  manifestDigest: sha256Schema,
  target: capabilityTargetSchema,
  o5Counters: o5CampaignCountersSchema,
  fromMaturity: z.enum(MATURITIES),
  reviewer: humanReviewerSchema,
  decidedAt: timestampSchema,
  auditRef: relativeArtifactPathSchema,
  approvalDigest: sha256Schema,
  nonce: evidenceIdSchema.optional(),
  expiresAt: timestampSchema.optional(),
} as const;

export const capabilityPromotionDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    ...promotionDecisionFields,
    decision: z.literal('promote'),
    promotedMaturity: z.enum(MATURITIES),
  }).strict(),
  z.object({
    ...promotionDecisionFields,
    decision: z.literal('emergency_demote'),
    demotedMaturity: z.enum(MATURITIES),
    reason: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({
    ...promotionDecisionFields,
    decision: z.literal('reject'),
    refusalCode: evidenceIdSchema,
  }).strict(),
]).readonly();

export const capabilityPromotionEnvelopeSchema = z.object({
  version: z.literal(CAPABILITY_EVIDENCE_VERSION),
  request: capabilityPromotionRequestSchema,
  decision: capabilityPromotionDecisionSchema.nullable(),
}).strict().superRefine((envelope, context) => {
  const decision = envelope.decision;
  if (decision === null) return;
  if (decision.requestId !== envelope.request.requestId
    || decision.manifestId !== envelope.request.manifestId
    || decision.manifestDigest !== envelope.request.manifestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'decision does not bind the exact request manifest' });
  }
  const requestTarget = envelope.request.target;
  const decisionTarget = decision.target;
  if (decisionTarget.productId !== requestTarget.productId
    || decisionTarget.capabilityId !== requestTarget.capabilityId
    || decisionTarget.toolId !== requestTarget.toolId
    || decisionTarget.workAtomIds.length !== requestTarget.workAtomIds.length
    || decisionTarget.workAtomIds.some((id, index) => id !== requestTarget.workAtomIds[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'target'], message: 'decision target differs from request' });
  }
  O5_COUNTER_KEYS.forEach((key) => {
    if (decision.o5Counters[key] !== envelope.request.o5Counters[key]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'o5Counters', key], message: 'decision counters differ from request' });
    }
  });
  if (Date.parse(decision.decidedAt) < Date.parse(envelope.request.requestedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'decidedAt'], message: 'decision precedes request' });
  }
  if (decision.fromMaturity !== envelope.request.fromMaturity) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'fromMaturity'], message: 'decision source maturity differs from request' });
  }
  if (decision.reviewer.actorId === envelope.request.requestedBy.actorId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'reviewer'], message: 'reviewer must be independent from requester' });
  }
  if (decision.decision === 'promote' && decision.promotedMaturity !== envelope.request.requestedMaturity) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'promotedMaturity'], message: 'promoted maturity differs from request' });
  }
  if (decision.decision === 'emergency_demote' && decision.demotedMaturity !== envelope.request.requestedMaturity) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision', 'demotedMaturity'], message: 'demoted maturity differs from request' });
  }
}).readonly();

export type CapabilityPromotionRequest = z.infer<typeof capabilityPromotionRequestSchema>;
export type CapabilityPromotionDecision = z.infer<typeof capabilityPromotionDecisionSchema>;
export type CapabilityPromotionEnvelope = z.infer<typeof capabilityPromotionEnvelopeSchema>;
