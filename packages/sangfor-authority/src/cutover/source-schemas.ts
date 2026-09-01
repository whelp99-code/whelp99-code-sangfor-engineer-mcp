import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from './source-files.js';

const stringArray = z.array(z.string());
export const vendorSchema = z.object({
  product: z.string(), label: z.string(), advisorTools: stringArray, credentialFields: stringArray,
  defaultArgs: jsonObjectSchema.optional(),
}).strict();
export const deviceSchema = z.object({
  id: z.string().min(1), name: z.string(), product: z.string(), host: z.string(), tags: stringArray,
  credentialEnv: z.record(z.string()).optional(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const playbookSchema = z.object({
  id: z.string().min(1), name: z.string(), goal: z.string(), revisions: z.array(jsonObjectSchema),
  createdAt: z.string(), updatedAt: z.string(), seedKey: z.string().optional(),
}).strict();
export const runSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), toolId: z.string(),
  toolSafety: z.enum(['read_only', 'write', 'destructive']), args: jsonObjectSchema,
  status: z.enum(['pending_approval', 'rejected', 'running', 'succeeded', 'failed']),
  requestedAt: z.string(), finishedAt: z.string().optional(), durationMs: z.number().optional(),
  resultSummary: z.string().optional(), resultJson: jsonValueSchema.optional(), error: z.string().optional(),
  deviceId: z.string().optional(), sweepId: z.string().optional(), approval: jsonObjectSchema.optional(),
  rejectedReason: z.string().optional(), playbookId: z.string().optional(), playbookRunId: z.string().optional(),
  playbookRev: z.number().int().optional(), blockId: z.string().optional(),
}).strict();
export const analysisSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), playbookId: z.string(), playbookRunId: z.string(),
  summary: z.string(), improvements: z.array(jsonObjectSchema), proposals: z.array(jsonObjectSchema),
  authoredBy: z.string(), createdAt: z.string(),
}).strict();
export const auditSchema = z.object({
  seq: z.number().int().nonnegative(), at: z.string(), runId: z.string().min(1),
  kind: z.enum(['request', 'response', 'state', 'verdict']), payload: jsonValueSchema,
  prevHash: z.string(), hash: z.string(), keyed: z.boolean(),
}).strict();
const engineerReportSchema = z.object({
  schemaVersion: z.literal(1), reportId: z.string(), deviceId: z.string(), snapshotHash: z.string(),
  engineResult: jsonObjectSchema, riskNote: z.string(), recommendations: stringArray, rollbackPlan: stringArray,
  ragCitations: z.array(z.object({ chunkId: z.string(), filePath: z.string() }).strict()),
  modelId: z.string(), promptHash: z.string(), createdAt: z.string(),
}).strict();
export const engineerReportRecordSchema = z.object({
  seq: z.number().int().positive(), prevHash: z.string(), hash: z.string(), report: engineerReportSchema,
}).strict();
export const agentTaskSchema = z.object({
  id: z.string().min(1), kind: z.enum(['assemble', 'revise', 'analyze']), payload: jsonObjectSchema,
  status: z.enum(['open', 'done', 'cancelled']), result: jsonObjectSchema.optional(),
  createdAt: z.string(), closedAt: z.string().optional(),
}).strict();
export const feedbackSchema = z.union([
  z.object({ id: z.string(), product: z.string(), feedbackType: z.string(), severity: z.enum(['low', 'medium', 'high', 'critical']), feedbackText: z.string(), sourceRole: z.enum(['user', 'engineer', 'codex', 'verifier', 'customer']), status: z.enum(['new', 'lesson_extracted', 'closed']) }).strict(),
  z.object({ id: z.string(), feedbackId: z.string(), product: z.string(), lessonTitle: z.string(), lessonBody: z.string(), rootCause: z.string(), recommendedAction: z.string(), antiPattern: z.string(), approvalStatus: z.enum(['pending_review', 'approved', 'rejected']) }).strict(),
]);
export const evalSchema = z.object({ id: z.string(), name: z.string(), product: z.string(), requiredText: z.string() }).strict();
export const wikiSchema = z.union([
  z.object({ id: z.string(), targetPage: z.string(), title: z.string(), beforeText: z.string(), afterText: z.string(), status: z.enum(['pending', 'approved', 'rejected', 'applied']), adapter: z.enum(['memory', 'obsidian', 'github_wiki']).optional(), reviewer: z.string().optional() }).strict(),
  z.object({ id: z.string(), product: z.string(), version: z.string().optional(), type: z.string(), title: z.string(), symptom: z.string().optional(), cause: z.string().optional(), prerequisites: stringArray, steps: stringArray, warnings: stringArray, verification: stringArray, rollback: stringArray, citations: z.array(z.object({ sourceId: z.string(), sourceRevision: z.string().optional(), headingPath: stringArray.optional(), spanText: z.string(), quoteHash: z.string() }).strict()), trustLevel: z.string(), updatedAt: z.string() }).strict(),
]);
const strategyRevisionSchema = z.object({
  revisionId: z.string(), strategyId: z.string(), state: z.string(), contentHash: z.string(),
  derivedFromRevisionId: z.string().optional(), createdAt: z.string(), evidenceFile: z.string().optional(),
  evidenceDigest: z.string().optional(), methods: stringArray.optional(),
  scope: z.object({ product: z.string(), firmwareVersion: z.string(), capability: z.string().optional(), fact: z.string().optional() }).strict().optional(),
  registryDigest: z.string().optional(), versionTruthRecord: z.string().optional(),
  vendor: z.enum(['SANGFOR', 'FORTINET', 'CISCO']).optional(), productVariant: z.string().optional(),
}).strict();
export const learningGenerationSchema = z.object({
  generation: z.number().int().positive(), revisions: z.array(strategyRevisionSchema), contentHash: z.string(),
}).strict();
export const learningSchema = z.object({
  schemaVersion: z.literal(1), strategyId: z.string(), generations: z.array(learningGenerationSchema),
  currentGeneration: z.number().int().nonnegative(), mirrorOutbox: z.array(jsonObjectSchema),
  mirrorReceipts: z.array(jsonObjectSchema), lifecycleEvents: z.array(jsonObjectSchema),
}).strict();
export const chronicleSchema = z.object({ deviceId: z.string(), headHash: z.string().optional(), snapshots: z.array(jsonObjectSchema) }).strict();
const promotionTargetSchema = z.object({
  productId: z.string(), capabilityId: z.string(), toolId: z.string(), workAtomIds: stringArray,
}).strict();
export const promotionCheckpointSchema = z.object({
  version: z.literal(1), eventCount: z.number().int().nonnegative(), lastHash: z.string(), hmac: z.string(),
}).strict();
export const promotionEventSchema = z.object({
  version: z.literal(1), eventId: z.string(), seq: z.number().int().nonnegative(), at: z.string(),
  outcome: z.enum(['applied', 'rejected']), action: z.enum(['promote', 'emergency_demote', 'stale', 'reject']),
  target: promotionTargetSchema, fromMaturity: z.string(), toMaturity: z.string(), decisionRef: z.string(),
  manifestRef: z.string(), nonceRef: z.string().nullable(), refusalCode: z.string().nullable(),
  invalidation: z.object({ reason: z.enum(['evidence_expired', 'identity_drift']), observedIdentityRef: z.string() }).strict().optional(),
  prevHash: z.string(), hash: z.string(),
}).strict();
