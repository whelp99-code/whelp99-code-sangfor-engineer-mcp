import { z } from 'zod';
import type { RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { LearningApprovalPayload } from './approval.js';
import type {
  PromoteStrategyRequest,
  ResearchStrategyRequest,
  ValidateStrategyRequest,
} from './service.js';
import type { ResolverContext, StrategyScope } from './resolver.js';
import type { StrategyStore } from './store.js';

const idSchema = z.string().min(1).max(512);
const pathSchema = z.string().min(1).max(16_384);
const timestampSchema = z.string().min(1).max(128);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const stateSchema = z.enum([
  'draft', 'researched', 'lab_verified', 'device_verified',
  'strategy_field_verified', 'stale', 'deprecated',
]);
const methodSchema = z.enum([
  'LM-01', 'LM-02', 'LM-03', 'LM-04', 'LM-05', 'LM-06', 'LM-07', 'LM-08',
  'LR-01', 'LR-02', 'LR-03', 'LR-04',
]);

export const strategyScopeRuntimeSchema: RuntimeCodec<StrategyScope> = z.object({
  product: idSchema,
  firmwareVersion: z.string().min(1).max(256),
  capability: idSchema.optional(),
  fact: idSchema.optional(),
}).strict();

export const resolverContextRuntimeSchema: RuntimeCodec<ResolverContext> = z.object({
  registryDigest: hashSchema,
  versionTruthRecord: pathSchema,
  productVariant: idSchema.optional(),
  deviceScope: idSchema.optional(),
  environment: z.enum(['lab', 'poc', 'customer', 'production']).optional(),
}).strict();

export const learningApprovalPayloadRuntimeSchema: RuntimeCodec<LearningApprovalPayload> = z.object({
  entityType: idSchema,
  entityId: idSchema,
  revisionId: idSchema,
  contentHash: hashSchema,
  fromState: stateSchema,
  toState: stateSchema,
  evidenceFile: pathSchema,
  evidenceDigest: hashSchema,
  nonce: idSchema,
  expiresAt: timestampSchema,
}).strict();

export const researchStrategyRequestRuntimeSchema: RuntimeCodec<ResearchStrategyRequest> = z.object({
  strategyId: idSchema,
  vendor: z.enum(['SANGFOR', 'FORTINET', 'CISCO']),
  scope: strategyScopeRuntimeSchema,
  registryDigest: hashSchema,
  versionTruthRecord: pathSchema,
  productVariant: idSchema.optional(),
  officialCitation: z.string().min(1).max(16_384),
  pageVerified: z.boolean(),
  captureEvidenceFile: pathSchema.optional(),
  methods: z.array(methodSchema).max(12).optional(),
}).strict();

export const validateStrategyRequestRuntimeSchema: RuntimeCodec<ValidateStrategyRequest> = z.object({
  strategyId: idSchema,
  revisionId: idSchema,
  evidenceFile: pathSchema.optional(),
  evidenceDigest: hashSchema.optional(),
}).strict();

export const promoteStrategyRequestRuntimeSchema: RuntimeCodec<PromoteStrategyRequest> = z.object({
  strategyId: idSchema,
  revisionId: idSchema,
  evidenceFile: pathSchema.optional(),
  evidenceDigest: hashSchema.optional(),
  toState: stateSchema,
  approvalPayload: learningApprovalPayloadRuntimeSchema,
  approvalToken: hashSchema,
  evidenceRoot: pathSchema,
}).strict();

const mirrorMetadataSchema = z.object({
  strategyId: idSchema.optional(),
  revisionId: idSchema.optional(),
  state: idSchema.optional(),
  contentDigest: hashSchema.optional(),
  evidenceDigest: hashSchema.optional(),
  methodCodes: z.array(methodSchema).max(12).optional(),
  deviceScopeDigest: hashSchema.optional(),
  coverage: z.record(idSchema, z.number().finite()).optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  status: idSchema.optional(),
  methodCode: methodSchema.optional(),
  vendor: idSchema.optional(),
  productCode: idSchema.optional(),
  productVariant: idSchema.optional(),
  versionRaw: z.string().max(256).optional(),
  specVersion: z.string().max(256).optional(),
  registryDigest: hashSchema.optional(),
  uiFingerprint: hashSchema.optional(),
  apiFingerprint: hashSchema.optional(),
  fromState: stateSchema.optional(),
  toState: stateSchema.optional(),
  evidenceKind: idSchema.optional(),
  completedAt: timestampSchema.optional(),
}).strict();

const mirrorOutboxSchema = z.object({
  eventId: idSchema,
  eventType: z.enum(['strategy_revision', 'lifecycle_event', 'method_catalog', 'firmware_profile', 'evidence', 'run']),
  occurredAt: timestampSchema,
  payloadDigest: hashSchema,
  metadata: mirrorMetadataSchema,
  status: z.enum(['pending', 'mirrored', 'dlq']),
  attempts: z.number().int().min(0).max(10),
  nextAttemptAt: timestampSchema,
  lastErrorCode: idSchema.optional(),
}).strict();

const revisionSchema = z.object({
  revisionId: idSchema,
  strategyId: idSchema,
  state: stateSchema,
  contentHash: hashSchema,
  derivedFromRevisionId: idSchema.optional(),
  createdAt: timestampSchema,
  evidenceFile: pathSchema.optional(),
  evidenceDigest: hashSchema.optional(),
  methods: z.array(methodSchema).max(12).optional(),
  scope: strategyScopeRuntimeSchema.optional(),
  registryDigest: hashSchema.optional(),
  versionTruthRecord: pathSchema.optional(),
  vendor: z.enum(['SANGFOR', 'FORTINET', 'CISCO']).optional(),
  productVariant: idSchema.optional(),
}).strict();

const generationSchema = z.object({
  generation: z.number().int().positive(),
  revisions: z.array(revisionSchema).max(100_000),
  contentHash: hashSchema,
}).strict();

export const strategyStoreRuntimeSchema: RuntimeCodec<StrategyStore> = z.object({
  schemaVersion: z.literal(1),
  strategyId: idSchema,
  generations: z.array(generationSchema).max(100_000),
  currentGeneration: z.number().int().nonnegative(),
  mirrorOutbox: z.array(mirrorOutboxSchema).max(100_000),
  mirrorReceipts: z.array(z.object({
    eventId: idSchema,
    payloadDigest: hashSchema,
    mirroredAt: timestampSchema,
    status: z.literal('mirrored'),
  }).strict()).max(100_000),
  lifecycleEvents: z.array(z.object({
    type: z.literal('learning.lifecycle.approval'),
    domain: z.literal('learning-strategy-v1'),
    occurredAt: timestampSchema,
    payload: learningApprovalPayloadRuntimeSchema,
  }).strict()).max(100_000),
}).strict();
