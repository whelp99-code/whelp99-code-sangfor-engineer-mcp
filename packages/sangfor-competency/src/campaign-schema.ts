import { z } from 'zod';
import { LIFECYCLE_PHASES, AUTOMATABILITIES, MATURITIES } from './schema.js';
import { relativeArtifactPathSchema, sha256Schema } from './evidence-primitives.js';

export const CAPABILITY_CAMPAIGN_VERSION = 1 as const;
export const CAMPAIGN_PRODUCTS = ['HCI', 'IAG', 'EPP', 'CC'] as const;
export const CAMPAIGN_READINESS = ['BLOCKED', 'READY'] as const;

const campaignRequirementStructuralSchema = z.object({
  atomId: z.string().trim().min(1),
  atomSha256: sha256Schema,
  product: z.string().trim().min(1),
  phase: z.enum(LIFECYCLE_PHASES),
  automatability: z.enum(AUTOMATABILITIES),
  maturity: z.enum(MATURITIES),
  capabilityRef: z.object({ product: z.string().min(1), capabilityId: z.string().min(1) }).strict().readonly().nullable(),
  toolRef: z.string().trim().min(1).nullable(),
  evidence: z.object({
    required: z.literal(true),
    o5Required: z.boolean(),
    requirementPath: relativeArtifactPathSchema,
  }).strict().readonly(),
}).strict().readonly();

const capabilityCampaignStructuralSchema = z.object({
  version: z.literal(CAPABILITY_CAMPAIGN_VERSION),
  kind: z.literal('capability_campaign_requirements'),
  campaignId: z.string().trim().min(1),
  product: z.enum(CAMPAIGN_PRODUCTS),
  catalog: z.object({ catalogHash: sha256Schema, atomCount: z.number().int().positive() }).strict().readonly(),
  readiness: z.object({
    status: z.enum(CAMPAIGN_READINESS),
    prerequisites: z.array(z.string().trim().min(1)).min(1).readonly(),
  }).strict().readonly(),
  paths: z.object({
    labReadiness: relativeArtifactPathSchema,
    deviceInventory: relativeArtifactPathSchema,
    firmwareTruth: relativeArtifactPathSchema,
    executionWindow: relativeArtifactPathSchema,
    humanApproval: relativeArtifactPathSchema,
    evidenceRoot: relativeArtifactPathSchema,
  }).strict().readonly(),
  requirements: z.array(campaignRequirementStructuralSchema).min(1).readonly(),
}).strict().superRefine((manifest, context) => {
  const ids = manifest.requirements.map(({ atomId }) => atomId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requirements'], message: 'duplicate campaign atom' });
  }
}).readonly();

export type CampaignProduct = (typeof CAMPAIGN_PRODUCTS)[number];
export type CapabilityCampaignManifest = z.infer<typeof capabilityCampaignStructuralSchema>;
export type CampaignRequirement = z.infer<typeof campaignRequirementStructuralSchema>;

/** @internal Structural parsing is not catalog authority. */
export function parseCampaignStructure(value: unknown): CapabilityCampaignManifest {
  return capabilityCampaignStructuralSchema.parse(value);
}
