import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../../packages/shared/src/runtime-json-codecs.js';
import {
  parseRuntimeJson,
  type NamedRuntimeCodec,
  type RuntimeCodec,
} from '../../../packages/shared/src/runtime-schema.js';
import type {
  AgentTask,
  Playbook,
  PlaybookAnalysis,
} from './playbook-store.js';
import type { Device, VendorDescriptor } from './registry.js';
import {
  controlTowerRequestSchemas,
  type ControlTowerRequestBody,
  type ControlTowerRequestRoute,
} from './request-boundaries.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(1_000_000);
const stringListSchema = z.array(z.string().max(4_096)).max(10_000);
const timestampSchema = z.string().min(1).max(128);

const playbookBlockSchema = z.object({
  id: idSchema,
  type: z.enum(['tool', 'report']),
  title: textSchema.optional(),
  toolId: idSchema.optional(),
  args: runtimeJsonObjectSchema.optional(),
  deviceId: idSchema.optional(),
}).strict();

const playbookRevisionSchema = z.object({
  rev: z.number().int().positive(),
  blocks: z.array(playbookBlockSchema).max(10_000),
  authoredBy: idSchema,
  note: textSchema.optional(),
  status: z.enum(['draft', 'approved', 'rejected']),
  createdAt: timestampSchema,
  reviewedBy: idSchema.optional(),
  reviewedAt: timestampSchema.optional(),
  rejectReason: textSchema.optional(),
}).strict();

const playbookSchema: RuntimeCodec<Playbook> = z.object({
  id: idSchema,
  name: textSchema,
  goal: textSchema,
  revisions: z.array(playbookRevisionSchema).max(10_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  seedKey: idSchema.optional(),
}).strict();

const analysisImprovementSchema = z.object({
  observation: textSchema,
  evidenceRunId: idSchema.optional(),
  recommendation: textSchema,
  verdict: z.enum(['accepted', 'dismissed']).optional(),
  reviewedBy: idSchema.optional(),
}).strict();

const analysisProposalSchema = z.object({
  action: textSchema,
  rationale: textSchema,
  linkedPlaybookId: idSchema.optional(),
  verdict: z.enum(['accepted', 'dismissed']).optional(),
  reviewedBy: idSchema.optional(),
}).strict();

const playbookAnalysisSchema: RuntimeCodec<PlaybookAnalysis> = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  playbookId: idSchema,
  playbookRunId: idSchema,
  summary: textSchema,
  improvements: z.array(analysisImprovementSchema).max(10_000),
  proposals: z.array(analysisProposalSchema).max(10_000),
  authoredBy: idSchema,
  createdAt: timestampSchema,
}).strict();

const agentTaskSchema: RuntimeCodec<AgentTask> = z.object({
  id: idSchema,
  kind: z.enum(['assemble', 'revise', 'analyze']),
  payload: z.object({
    goal: textSchema.optional(),
    playbookId: idSchema.optional(),
    playbookRunId: idSchema.optional(),
    feedback: textSchema.optional(),
  }).strict(),
  status: z.enum(['open', 'done', 'cancelled']),
  result: z.object({
    playbookId: idSchema.optional(),
    rev: z.number().int().positive().optional(),
    analysisId: idSchema.optional(),
    note: textSchema.optional(),
  }).strict().optional(),
  createdAt: timestampSchema,
  closedAt: timestampSchema.optional(),
}).strict();

const vendorDescriptorSchema: RuntimeCodec<VendorDescriptor> = z.object({
  product: idSchema,
  label: textSchema,
  advisorTools: stringListSchema,
  credentialFields: stringListSchema,
  defaultArgs: runtimeJsonObjectSchema.optional(),
}).strict();

const deviceSchema: RuntimeCodec<Device> = z.object({
  id: idSchema,
  name: textSchema,
  product: idSchema,
  host: z.string().min(1).max(4_096),
  tags: stringListSchema,
  credentialEnv: z.record(z.string().min(1).max(256), z.string().min(1).max(256)).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const vendorRegistryCodec: NamedRuntimeCodec<VendorDescriptor[]> = {
  schema: z.array(vendorDescriptorSchema).max(10_000),
  schemaName: 'control-tower.vendor-registry.v1',
};

export const deviceRegistryCodec: NamedRuntimeCodec<Device[]> = {
  schema: z.array(deviceSchema).max(100_000),
  schemaName: 'control-tower.device-registry.v1',
};

export function parseBoundaryControlTowerPlaybooksV1(source: string): Playbook[] {
  return parseRuntimeJson(source, {
    schema: z.array(playbookSchema).max(10_000),
    schemaName: 'control-tower.playbooks.v1',
    policy: 'freeze',
    uniqueIdCollectionPath: [],
  });
}

export function parseBoundaryControlTowerAnalysisLineV1(source: string): PlaybookAnalysis {
  return parseRuntimeJson(source, {
    schema: playbookAnalysisSchema,
    schemaName: 'control-tower.playbook-analysis.v1',
    policy: 'invalid_report',
    expectedVersion: 1,
    versionPath: ['schemaVersion'],
  });
}

export function parseBoundaryControlTowerAgentTasksV1(source: string): AgentTask[] {
  return parseRuntimeJson(source, {
    schema: z.array(agentTaskSchema).max(100_000),
    schemaName: 'control-tower.agent-tasks.v1',
    policy: 'freeze',
    uniqueIdCollectionPath: [],
  });
}

export function parseBoundaryControlTowerRegistryV1<TOutput, TInput>(
  source: string,
  codec: NamedRuntimeCodec<TOutput, TInput>,
): TOutput {
  return parseRuntimeJson(source, {
    ...codec,
    schemaName: 'control-tower.registry.v1',
    policy: 'freeze',
    uniqueIdCollectionPath: [],
  });
}

type AnyControlTowerRequestBody = ControlTowerRequestBody<ControlTowerRequestRoute>;

const controlTowerRequestSchema: RuntimeCodec<AnyControlTowerRequestBody> = z.union([
  controlTowerRequestSchemas['device-create'],
  controlTowerRequestSchemas['device-update'],
  controlTowerRequestSchemas.sweep,
  controlTowerRequestSchemas['approval-mint'],
  controlTowerRequestSchemas['run-create'],
  controlTowerRequestSchemas['playbook-seed'],
  controlTowerRequestSchemas['playbook-create'],
  controlTowerRequestSchemas['revision-review'],
  controlTowerRequestSchemas['revision-create'],
  controlTowerRequestSchemas['analysis-submit'],
  controlTowerRequestSchemas['analysis-verdict'],
  controlTowerRequestSchemas['agent-task-create'],
  controlTowerRequestSchemas['agent-task-close'],
  controlTowerRequestSchemas['run-approve'],
  controlTowerRequestSchemas['run-reject'],
  controlTowerRequestSchemas['enrollment-bootstrap-token'],
  controlTowerRequestSchemas['enrollment-bootstrap-claim'],
  controlTowerRequestSchemas['enrollment-rotate'],
  controlTowerRequestSchemas['enrollment-acknowledge'],
  controlTowerRequestSchemas['enrollment-revoke'],
  controlTowerRequestSchemas['remote-browser-job'],
]);

export function decodeControlTowerRequestBody<TRoute extends ControlTowerRequestRoute>(
  value: AnyControlTowerRequestBody,
  route: TRoute,
): ControlTowerRequestBody<TRoute> {
  return controlTowerRequestSchemas[route].parse(value);
}

export function parseBoundaryControlTowerRequestBodyV1(source: string): AnyControlTowerRequestBody {
  return parseRuntimeJson(source, {
    schema: controlTowerRequestSchema,
    schemaName: 'control-tower.request-body.v1',
    policy: 'deny',
  });
}
