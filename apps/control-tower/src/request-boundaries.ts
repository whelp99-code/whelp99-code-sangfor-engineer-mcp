import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../../packages/shared/src/runtime-json-codecs.js';
import {
  acknowledgeRotationInputSchema,
  claimBootstrapTokenInputSchema,
  issueBootstrapTokenRequestSchema,
  leafCertificateSchema,
  revokeEnrollmentInputSchema,
  rotateEnrollmentInputSchema,
} from '../../../packages/sangfor-browser-contracts/src/index.js';

const textSchema = z.string().max(1_000_000);
const idSchema = z.string().max(4_096);
const stringListSchema = z.array(z.string().max(4_096)).max(100_000);

const credentialEnvSchema = z.record(
  z.string().min(1).max(256),
  z.string().min(1).max(256),
);

const deviceFields = {
  name: textSchema.optional(),
  product: idSchema.optional(),
  host: textSchema.optional(),
  tags: stringListSchema.optional(),
  credentialEnv: credentialEnvSchema.optional(),
} as const;

const playbookBlockSchema = z.object({
  id: idSchema,
  type: z.enum(['tool', 'report']),
  title: textSchema.optional(),
  toolId: idSchema.optional(),
  args: runtimeJsonObjectSchema.optional(),
  deviceId: idSchema.optional(),
}).strict();

const improvementSchema = z.object({
  observation: textSchema,
  evidenceRunId: idSchema.optional(),
  recommendation: textSchema,
  verdict: z.enum(['accepted', 'dismissed']).optional(),
  reviewedBy: idSchema.optional(),
}).strict();

const proposalSchema = z.object({
  action: textSchema,
  rationale: textSchema,
  linkedPlaybookId: idSchema.optional(),
  verdict: z.enum(['accepted', 'dismissed']).optional(),
  reviewedBy: idSchema.optional(),
}).strict();

const agentPayloadSchema = z.object({
  goal: textSchema.optional(),
  playbookId: idSchema.optional(),
  playbookRunId: idSchema.optional(),
  feedback: textSchema.optional(),
}).strict();

const agentResultSchema = z.object({
  playbookId: idSchema.optional(),
  rev: z.number().int().positive().optional(),
  analysisId: idSchema.optional(),
  note: textSchema.optional(),
}).strict();

export const controlTowerRequestSchemas = {
  'device-create': z.object(deviceFields).strict(),
  'device-update': z.object(deviceFields).strict(),
  sweep: z.object({ deviceIds: stringListSchema.optional() }).strict(),
  'approval-mint': z.object({
    actionType: idSchema.optional(),
    actionTarget: textSchema.optional(),
    approvedBy: idSchema.optional(),
    changeTicketId: idSchema.optional(),
    rollbackPlanId: idSchema.optional(),
    authorityEpoch: z.number().int().nonnegative().optional(),
    ttlSec: z.number().finite().positive().optional(),
  }).strict(),
  'run-create': z.object({
    toolId: idSchema.optional(),
    args: runtimeJsonObjectSchema.optional(),
    deviceId: idSchema.optional(),
  }).strict(),
  'playbook-seed': z.object({ authoredBy: idSchema.optional() }).strict(),
  'playbook-create': z.object({
    name: textSchema.optional(),
    goal: textSchema.optional(),
    authoredBy: idSchema.optional(),
    note: textSchema.optional(),
    blocks: z.array(playbookBlockSchema).max(100_000).optional(),
  }).strict(),
  'revision-review': z.object({
    reviewedBy: idSchema.optional(),
    reason: textSchema.optional(),
  }).strict(),
  'revision-create': z.object({
    authoredBy: idSchema.optional(),
    note: textSchema.optional(),
    blocks: z.array(playbookBlockSchema).max(100_000).optional(),
  }).strict(),
  'analysis-submit': z.object({
    playbookId: idSchema.optional(),
    playbookRunId: idSchema.optional(),
    summary: textSchema.optional(),
    authoredBy: idSchema.optional(),
    improvements: z.array(improvementSchema).max(100_000).optional(),
    proposals: z.array(proposalSchema).max(100_000).optional(),
  }).strict(),
  'analysis-verdict': z.object({
    part: z.enum(['improvements', 'proposals']).optional(),
    index: z.number().int().nonnegative().optional(),
    verdict: z.enum(['accepted', 'dismissed']).optional(),
    reviewedBy: idSchema.optional(),
    linkedPlaybookId: idSchema.optional(),
  }).strict(),
  'agent-task-create': z.object({
    kind: z.enum(['assemble', 'revise', 'analyze']),
    payload: agentPayloadSchema,
  }).strict(),
  'agent-task-close': z.object({
    cancel: z.boolean().optional(),
    result: agentResultSchema.optional(),
  }).strict(),
  'run-approve': z.object({
    approvedBy: idSchema.optional(),
    changeTicketId: idSchema.optional(),
    rollbackPlanId: idSchema.optional(),
  }).strict(),
  'run-reject': z.object({ reason: textSchema.optional() }).strict(),
  'enrollment-bootstrap-token': issueBootstrapTokenRequestSchema,
  'enrollment-bootstrap-claim': claimBootstrapTokenInputSchema,
  'enrollment-rotate': rotateEnrollmentInputSchema,
  'enrollment-acknowledge': acknowledgeRotationInputSchema,
  'enrollment-revoke': revokeEnrollmentInputSchema,
  'remote-browser-job': z.object({
    purpose: z.enum(['mutation', 'verification']),
    bodyText: z.string().min(1).max(64 * 1024),
    target: z.object({
      installationId: idSchema,
      clientIdentityId: idSchema,
      deviceBindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      origin: z.string().url(),
      certificate: leafCertificateSchema,
      environment: z.enum(['lab', 'poc', 'production']),
    }).strict(),
  }).strict(),
} as const;

export function parseRunStatusQuery(value: string | undefined) {
  const result = z.enum(['pending_approval', 'rejected', 'running', 'succeeded', 'failed']).optional().safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseAgentTaskStatusQuery(value: string | undefined) {
  const result = z.enum(['open', 'done', 'cancelled']).optional().safeParse(value);
  return result.success ? result.data : undefined;
}

export type ControlTowerRequestRoute = keyof typeof controlTowerRequestSchemas;
export type ControlTowerRequestBody<TRoute extends ControlTowerRequestRoute> =
  z.output<(typeof controlTowerRequestSchemas)[TRoute]>;
