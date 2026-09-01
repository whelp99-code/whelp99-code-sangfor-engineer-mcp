import { z } from 'zod';
import {
  evidenceIdSchema,
  firmwareValueSchema,
  sha256Schema,
  timestampSchema,
} from './evidence-primitives.js';
import { EVIDENCE_CAMPAIGNS, type EvidenceValidationContext } from './evidence-validation-types.js';

const currentFirmwareIdentitySchema = z.object({
  vendor: z.enum(['SANGFOR', 'FORTINET', 'CISCO']),
  adapterProduct: evidenceIdSchema,
  productVariant: evidenceIdSchema.nullable(),
  versionRaw: firmwareValueSchema,
  versionFamily: firmwareValueSchema,
  revision: firmwareValueSchema.nullable(),
  buildId: firmwareValueSchema.nullable(),
  hotfix: firmwareValueSchema.nullable(),
  uiFingerprint: sha256Schema.nullable(),
  apiFingerprint: sha256Schema.nullable(),
  specVersion: firmwareValueSchema,
  truthDigest: sha256Schema,
}).strict().readonly();

const currentDigestsSchema = z.object({
  recipeDigest: sha256Schema,
  toolDigest: sha256Schema,
  runtimeDigest: sha256Schema,
  deviceIdentityDigest: sha256Schema,
  originDigest: sha256Schema,
  windowIdentityDigest: sha256Schema,
}).strict().readonly();

export const evidenceValidationContextSchema = z.object({
  campaign: z.enum(EVIDENCE_CAMPAIGNS),
  targetClassification: z.object({
    environment: z.enum(['lab', 'production']),
    token: sha256Schema,
  }).strict().readonly().optional(),
  evaluatedAt: timestampSchema,
  currentFirmware: currentFirmwareIdentitySchema,
  currentDigests: currentDigestsSchema,
  reviewer: z.object({ actorId: evidenceIdSchema, actorType: z.literal('human_pm') }).strict().readonly(),
  runIdentities: z.array(z.object({
    runId: evidenceIdSchema,
    environment: z.enum(['real_device', 'mock']),
    deviceIdentityDigest: sha256Schema,
    windowIdentityDigest: sha256Schema,
  }).strict().readonly()).min(1).max(100).readonly(),
}).strict().readonly();

export function parseEvidenceValidationContext(value: unknown): EvidenceValidationContext {
  const parsed = evidenceValidationContextSchema.parse(value);
  return {
    campaign: parsed.campaign,
    ...(parsed.targetClassification === undefined
      ? {}
      : { targetClassification: parsed.targetClassification }),
    clock: { now: () => new Date(parsed.evaluatedAt) },
    currentFirmware: parsed.currentFirmware,
    currentDigests: parsed.currentDigests,
    reviewerActorId: parsed.reviewer.actorId,
    runIdentities: parsed.runIdentities,
  };
}
