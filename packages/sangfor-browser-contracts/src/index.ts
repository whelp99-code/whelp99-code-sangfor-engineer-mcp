import { z } from 'zod';
import { isReadOnlyEvidenceLabel } from './security.js';

export {
  isLoopbackBrowserTarget,
  isReadOnlyEvidenceLabel,
  maskSensitiveMetadataText,
} from './security.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const identifierSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/,
    'Opaque identifier must not contain path separators.',
  )
  .refine(
    (value) => !value.includes('..'),
    'Opaque identifier must not contain path traversal segments.',
  );
const originSchema = z.string().url().transform((value) => new URL(value).origin);

const menuStepSchema = z.object({
  menu: z.string().trim().min(1),
  submenu: z.string().trim().min(1).optional(),
}).strict();

const readOnlyEvidenceLabelSchema = z.string().trim().min(1).refine(
  isReadOnlyEvidenceLabel,
  'Evidence navigation must be read-only; destructive labels are refused.',
);

const readOnlyMenuStepSchema = z.object({
  menu: readOnlyEvidenceLabelSchema,
  submenu: readOnlyEvidenceLabelSchema.optional(),
}).strict();

export const consoleActionSchema = z.object({
  type: z.enum(['navigate', 'click', 'type', 'select', 'scroll', 'screenshot', 'wait']),
  target: z.string().trim().min(1).optional(),
  value: z.string().optional(),
  dryRun: z.boolean().optional(),
}).strict();

const observeConsoleSchema = z.object({
  kind: z.literal('observe_console'),
  includeSnapshot: z.boolean().optional(),
}).strict();

const performConsoleActionSchema = z.object({
  kind: z.literal('perform_console_action'),
  action: consoleActionSchema,
  menuPath: z.array(menuStepSchema).optional(),
  formFields: z.array(z.object({
    type: z.enum(['text', 'password', 'select', 'checkbox', 'textarea', 'combobox', 'radio']),
    name: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    placeholder: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    value: z.string().optional(),
    options: z.array(z.string()).optional(),
  }).strict().refine(
    (field) => field.name || field.id || field.placeholder || field.label || field.index !== undefined,
    { message: 'Form field requires a semantic name, id, placeholder, label, or index.' },
  )).optional(),
}).strict();

const verifyConsoleSchema = z.object({
  kind: z.literal('verify_console'),
  checks: z.array(z.object({
    id: identifierSchema,
    kind: z.enum(['text_contains', 'field_equals', 'element_present']),
    expected: z.string(),
  }).strict()).min(1),
}).strict();

const captureConsoleEvidenceSchema = z.object({
  kind: z.literal('capture_console_evidence'),
  captureId: identifierSchema,
  menuPath: z.array(readOnlyMenuStepSchema).min(1),
}).strict();

const captureStructureSchema = z.object({
  kind: z.literal('capture_structure'),
}).strict();

const extractAuthenticatedKnowledgeSchema = z.object({
  kind: z.literal('extract_authenticated_knowledge'),
  sourceUrl: z.string().url(),
}).strict();

const closeSessionSchema = z.object({
  kind: z.literal('close_session'),
}).strict();

export const browserExecutionOperationSchema = z.discriminatedUnion('kind', [
  observeConsoleSchema,
  performConsoleActionSchema,
  verifyConsoleSchema,
  captureConsoleEvidenceSchema,
  captureStructureSchema,
  extractAuthenticatedKnowledgeSchema,
  closeSessionSchema,
]);

export const browserExecutionRequestSchema = z.object({
  schemaVersion: z.literal('browser-execution-request.v1'),
  requestId: identifierSchema,
  sessionId: identifierSchema,
  origin: originSchema,
  profileRef: identifierSchema.optional(),
  authRef: identifierSchema.optional(),
  operation: browserExecutionOperationSchema,
}).strict().superRefine((request, context) => {
  if (
    request.operation.kind === 'perform_console_action'
    && request.operation.action.type === 'navigate'
    && request.operation.action.target
  ) {
    try {
      const target = new URL(request.operation.action.target, request.origin);
      if (target.origin !== request.origin) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operation', 'action', 'target'],
          message: `Navigation target origin ${target.origin} does not match ${request.origin}.`,
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operation', 'action', 'target'],
        message: 'Navigation target must be a valid same-origin URL.',
      });
    }
  }
  if (request.operation.kind === 'extract_authenticated_knowledge') {
    const source = new URL(request.operation.sourceUrl);
    if (source.origin !== request.origin) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operation', 'sourceUrl'],
        message: `Knowledge source origin ${source.origin} does not match ${request.origin}.`,
      });
    }
  }
});

export const browserOperationStatusSchema = z.enum([
  'PASS',
  'FAIL',
  'INDETERMINATE',
  'AUTH_REQUIRED',
  'TARGET_AMBIGUOUS',
  'UNSUPPORTED',
  'REFUSED',
]);

const readBackSchema = z.object({
  status: z.enum(['PASS', 'FAIL', 'INDETERMINATE']),
  observations: z.record(jsonValueSchema).optional(),
}).strict();

const artifactRefSchema = z.string()
  .regex(
    /^artifact:\/\/[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/,
    'Artifact reference must be an opaque artifact://provider/id URI.',
  )
  .refine(
    (value) => !value.includes('..'),
    'Artifact reference must not contain path traversal segments.',
  );

const evidenceRefSchema = z.object({
  artifactRef: artifactRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
}).strict();

export const browserExecutionResultSchema = z.object({
  schemaVersion: z.literal('browser-execution-result.v1'),
  requestId: identifierSchema,
  status: browserOperationStatusSchema,
  mutationAttempted: z.boolean(),
  readBack: readBackSchema.optional(),
  observations: z.record(jsonValueSchema).optional(),
  evidence: z.array(evidenceRefSchema),
  error: z.object({
    code: identifierSchema,
    message: z.string().min(1),
    remediation: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export type BrowserExecutionRequest = z.infer<typeof browserExecutionRequestSchema>;
export type BrowserExecutionResult = z.infer<typeof browserExecutionResultSchema>;
export type BrowserOperationStatus = z.infer<typeof browserOperationStatusSchema>;

export interface BrowserExecutionPort {
  execute(request: BrowserExecutionRequest): Promise<BrowserExecutionResult>;
}

export function isAuthoritativePass(result: BrowserExecutionResult): boolean {
  return result.status === 'PASS' && result.readBack?.status === 'PASS';
}
