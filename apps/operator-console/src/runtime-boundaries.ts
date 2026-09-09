import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../../packages/shared/src/runtime-json-codecs.js';
import { parseRuntimeJson } from '../../../packages/shared/src/runtime-schema.js';

const textSchema = z.string().max(1_000_000);
const shortTextSchema = z.string().max(4_096);
const engineerIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u).refine(
  (value) => value !== '.' && value !== '..' && !value.includes('..'),
);
const engineerArtifactSchema = z.object({
  id: engineerIdSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: shortTextSchema,
  payload: textSchema,
  sanitized: z.boolean(),
  retention: engineerIdSchema,
}).strict();
const projectSchema = z.object({
  customerName: textSchema,
  product: shortTextSchema.optional(),
  version: shortTextSchema.optional(),
  projectType: shortTextSchema.optional(),
  environment: runtimeJsonObjectSchema.optional(),
  requirements: z.array(textSchema).max(100_000).optional(),
  constraints: z.array(textSchema).max(100_000).optional(),
}).strict();

const automationSchema = z.object({
  product: shortTextSchema.optional(),
  targetUrl: textSchema.optional(),
  version: shortTextSchema.optional(),
  environment: z.enum(['lab', 'poc', 'customer', 'production']).optional(),
  preferApi: z.boolean().optional(),
}).strict();

const requestSchemas = {
  'analyze-project': projectSchema,
  'generate-config-plan': projectSchema.extend({ product: shortTextSchema }).strict(),
  'rag-search': z.object({
    query: textSchema,
    product: shortTextSchema.optional(),
    version: shortTextSchema.optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  }).strict(),
  'case-resolution': z.object({
    product: shortTextSchema,
    caseSummary: textSchema,
    resolution: textSchema,
    targetWikiPage: textSchema,
    sourceRole: shortTextSchema.optional(),
  }).strict(),
  'discover-console': automationSchema,
  'analyze-requirements': automationSchema.extend({
    requirements: z.array(textSchema).min(1).max(100_000),
    currentConfig: runtimeJsonObjectSchema.optional(),
  }).strict(),
  'import-excel': z.object({
    filePath: textSchema.optional(),
    fileName: shortTextSchema.optional(),
    contentBase64: z.string().max(64 * 1024 * 1024).optional(),
    sheetName: shortTextSchema.optional(),
    prioritizeOnly: z.boolean().optional(),
    generatePlan: z.boolean().optional(),
  }).strict(),
  feedback: z.object({
    product: shortTextSchema,
    feedbackType: shortTextSchema,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    feedbackText: textSchema,
    sourceRole: z.enum(['user', 'engineer', 'codex', 'verifier', 'customer']),
  }).strict(),
  'engineer-cases': z.object({
    requestId: engineerIdSchema,
    document: runtimeJsonObjectSchema,
    expectedRevision: engineerIdSchema.optional(),
    artifacts: z.array(engineerArtifactSchema).max(64).optional(),
  }).strict(),
  'engineer-cases-resume': z.object({
    caseId: engineerIdSchema,
  }).strict(),
  'engineer-cases-compare': z.object({
    caseId: engineerIdSchema,
    revision: engineerIdSchema,
  }).strict(),
  'engineer-cases-artifact': z.object({
    caseId: engineerIdSchema,
    artifactId: engineerIdSchema,
  }).strict(),
  'engineer-cases-review': z.object({
    caseId: engineerIdSchema.optional(),
    draft: z.object({
      caseId: engineerIdSchema.optional(),
      mode: z.enum(['existing', 'new']),
      product: shortTextSchema,
      firmware: shortTextSchema.optional(),
      revision: engineerIdSchema.optional(),
      requirementLines: z.array(textSchema).max(256),
      collections: z.array(z.object({
        id: engineerIdSchema.optional(),
        label: shortTextSchema,
        valueText: shortTextSchema.optional(),
        unit: shortTextSchema.optional(),
        collectionStatus: z.enum(['complete', 'partial', 'missing', 'failed', 'unsupported']).optional(),
      }).strict()).max(64),
    }).strict().optional(),
  }).strict(),
} as const;

export type OperatorRequestRoute = keyof typeof requestSchemas;
export type OperatorRequestBody<TRoute extends OperatorRequestRoute> =
  z.output<(typeof requestSchemas)[TRoute]>;
type AnyOperatorRequestBody = OperatorRequestBody<OperatorRequestRoute>;

const operatorRequestSchema: z.ZodType<AnyOperatorRequestBody> = z.union([
  requestSchemas['analyze-project'],
  requestSchemas['generate-config-plan'],
  requestSchemas['rag-search'],
  requestSchemas['case-resolution'],
  requestSchemas['discover-console'],
  requestSchemas['analyze-requirements'],
  requestSchemas['import-excel'],
  requestSchemas.feedback,
  requestSchemas['engineer-cases'],
  requestSchemas['engineer-cases-resume'],
  requestSchemas['engineer-cases-compare'],
  requestSchemas['engineer-cases-artifact'],
  requestSchemas['engineer-cases-review'],
]);

export function decodeOperatorRequestBody<TRoute extends OperatorRequestRoute>(
  value: AnyOperatorRequestBody,
  route: TRoute,
): OperatorRequestBody<TRoute> {
  return requestSchemas[route].parse(value);
}

export function parseBoundaryOperatorRequestBodyV1(source: string): AnyOperatorRequestBody {
  return parseRuntimeJson(source, {
    schema: operatorRequestSchema,
    schemaName: 'operator-console.request-body.v1',
    policy: 'deny',
  });
}
