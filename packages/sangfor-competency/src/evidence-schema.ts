import { z } from 'zod';
import {
  refineCapabilityEvidenceManifest,
  refineCapabilityEvidenceRun,
  refineNegativeCase,
} from './evidence-refinements.js';
import {
  actorIdentitySchema,
  capabilityTargetSchema,
  evidenceIdSchema,
  firmwareValueSchema,
  mediaTypeSchema,
  relativeArtifactPathSchema,
  sha256Schema,
  timestampSchema,
} from './evidence-primitives.js';

export const CAPABILITY_EVIDENCE_VERSION = 1 as const;
export const MAX_CAPABILITY_EVIDENCE_BYTES = 1_048_576 as const;
export const MAX_EVIDENCE_RUNS = 100 as const;
export const MAX_EVIDENCE_ARTIFACTS = 1_000 as const;
export const MAX_NEGATIVE_CASES = 200 as const;
export const EVIDENCE_RESULTS = ['pass', 'fail', 'indeterminate'] as const;

export const firmwareTruthEvidenceSchema = z.object({
  recordId: evidenceIdSchema,
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
  status: z.literal('verified'),
  observedAt: timestampSchema,
  evidenceFile: relativeArtifactPathSchema,
  specVersion: firmwareValueSchema,
  specApplicability: z.literal('verified'),
  truthDigest: sha256Schema,
}).strict().readonly();

export const capabilityEvidenceArtifactSchema = z.object({
  id: evidenceIdSchema,
  kind: z.enum(['run', 'readback', 'restore', 'retention_approval', 'negative', 'audit']),
  path: relativeArtifactPathSchema,
  fileType: z.literal('regular_file'),
  sha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative().safe(),
  mediaType: mediaTypeSchema,
  createdAt: timestampSchema,
}).strict().readonly();

export const negativeCaseSchema = z.object({
  id: evidenceIdSchema,
  caseCode: evidenceIdSchema,
  expectedRefusalCode: evidenceIdSchema,
  observedRefusalCode: evidenceIdSchema,
  result: z.enum(EVIDENCE_RESULTS),
  artifactIds: z.array(evidenceIdSchema).min(1).max(100).readonly(),
  testedAt: timestampSchema,
}).strict().superRefine(refineNegativeCase).readonly();

export const independentReadBackSchema = z.object({
  independent: z.literal(true),
  verifier: actorIdentitySchema,
  result: z.enum(EVIDENCE_RESULTS),
  observedStateDigest: sha256Schema,
  artifactId: evidenceIdSchema,
  observedAt: timestampSchema,
}).strict().readonly();

const postRunStateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('restored'), result: z.enum(EVIDENCE_RESULTS), readBackArtifactId: evidenceIdSchema }).strict(),
  z.object({ mode: z.literal('retained'), result: z.enum(EVIDENCE_RESULTS), approvalAuditRef: relativeArtifactPathSchema }).strict(),
]).readonly();

export const capabilityEvidenceRunSchema = z.object({
  id: evidenceIdSchema,
  result: z.enum(EVIDENCE_RESULTS),
  executor: actorIdentitySchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  independentReadBack: independentReadBackSchema,
  postRunState: postRunStateSchema,
  mutationAttempted: z.boolean(),
  mutationCount: z.number().int().nonnegative().safe(),
  retryCount: z.number().int().nonnegative().safe(),
  collateralMutationCount: z.number().int().nonnegative().safe(),
  auditRef: relativeArtifactPathSchema,
  evidenceChainRef: relativeArtifactPathSchema,
  artifactIds: z.array(evidenceIdSchema).min(1).max(100).readonly(),
  negativeCaseIds: z.array(evidenceIdSchema).max(MAX_NEGATIVE_CASES).readonly(),
}).strict().superRefine(refineCapabilityEvidenceRun).readonly();

export const O5_COUNTER_KEYS = [
  'runCount', 'passCount', 'failCount', 'indeterminateCount', 'independentReadBackPassCount',
  'negativeCasePassCount', 'restoredCount', 'retainedCount', 'mutationCount', 'retryCount',
  'collateralMutationCount',
] as const;

export const o5CampaignCountersSchema = z.object({
  runCount: z.number().int().nonnegative().safe(),
  passCount: z.number().int().nonnegative().safe(),
  failCount: z.number().int().nonnegative().safe(),
  indeterminateCount: z.number().int().nonnegative().safe(),
  independentReadBackPassCount: z.number().int().nonnegative().safe(),
  negativeCasePassCount: z.number().int().nonnegative().safe(),
  restoredCount: z.number().int().nonnegative().safe(),
  retainedCount: z.number().int().nonnegative().safe(),
  mutationCount: z.number().int().nonnegative().safe(),
  retryCount: z.number().int().nonnegative().safe(),
  collateralMutationCount: z.number().int().nonnegative().safe(),
}).strict().readonly();

const digestsSchema = z.object({
  recipeDigest: sha256Schema,
  toolDigest: sha256Schema,
  runtimeDigest: sha256Schema,
  deviceIdentityDigest: sha256Schema,
  windowIdentityDigest: sha256Schema,
}).strict().readonly();

export const capabilityEvidenceManifestSchema = z.object({
  version: z.literal(CAPABILITY_EVIDENCE_VERSION),
  manifestId: evidenceIdSchema,
  generatedAt: timestampSchema,
  target: capabilityTargetSchema,
  firmwareTruth: firmwareTruthEvidenceSchema,
  digests: digestsSchema,
  runs: z.array(capabilityEvidenceRunSchema).min(1).max(MAX_EVIDENCE_RUNS).readonly(),
  artifacts: z.array(capabilityEvidenceArtifactSchema).min(1).max(MAX_EVIDENCE_ARTIFACTS).readonly(),
  negativeCases: z.array(negativeCaseSchema).max(MAX_NEGATIVE_CASES).readonly(),
  o5Counters: o5CampaignCountersSchema,
}).strict().superRefine(refineCapabilityEvidenceManifest).readonly();

export type CapabilityEvidenceArtifact = z.infer<typeof capabilityEvidenceArtifactSchema>;
export type CapabilityEvidenceRun = z.infer<typeof capabilityEvidenceRunSchema>;
export type CapabilityEvidenceManifest = z.infer<typeof capabilityEvidenceManifestSchema>;
export type NegativeCase = z.infer<typeof negativeCaseSchema>;
export type O5CampaignCounters = z.infer<typeof o5CampaignCountersSchema>;
