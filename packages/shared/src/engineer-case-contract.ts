import { z } from 'zod';
import { PRODUCTS, type ProductCode } from './product-catalog.js';
import { parseRuntimeJson, RuntimeSchemaError } from './runtime-schema.js';

/**
 * Engineer-case JSON contract (E01).
 *
 * Compatibility: only `engineer-case.v1` is accepted. Missing, older, or newer
 * schema versions are refused. There is no silent upgrade adapter.
 *
 * This file is L0 contract only: no DB, UI, or live collection.
 */
export const ENGINEER_CASE_SCHEMA_VERSION = 'engineer-case.v1' as const;

export const ENGINEER_CASE_SCHEMA_POLICY = {
  current: ENGINEER_CASE_SCHEMA_VERSION,
  accepted: [ENGINEER_CASE_SCHEMA_VERSION],
  unsupportedAction: 'reject',
} as const;

export const ENGINEER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;
export const ENGINEER_DIGEST_RE = /^[a-f0-9]{64}$/u;

export const ENGINEER_SOURCE_KINDS = ['observed', 'provided', 'derived', 'proposed', 'unknown'] as const;
export const ENGINEER_CASE_MODES = ['existing', 'new'] as const;
export const ENGINEER_CASE_PROGRESS = [
  'draft',
  'inputs_pending',
  'assessment_ready',
  'guide_draft',
  'pm_review',
  'accepted',
] as const;
export const ENGINEER_ASSESSMENT_STATUSES = [
  'satisfied',
  'change_needed',
  'unresolved',
  'not_applicable',
] as const;
export const ENGINEER_GUIDE_READINESS = ['draft', 'blocked', 'review_ready'] as const;
export const ENGINEER_EXECUTION_RESULTS = [
  'not_started',
  'refused',
  'indeterminate',
  'fail',
  'pass',
] as const;
export const ENGINEER_COLLECTION_STATUSES = [
  'complete',
  'partial',
  'missing',
  'failed',
  'unsupported',
] as const;
export const ENGINEER_ENVIRONMENT_KINDS = ['fixture', 'historical_record', 'live'] as const;
export const ENGINEER_UNITS = [
  '1',
  'count',
  'percent',
  '%',
  'B',
  'KB',
  'KiB',
  'MB',
  'MiB',
  'GB',
  'GiB',
  'TB',
  'TiB',
  'cores',
  'vcpu',
  'MHz',
  'GHz',
  'ms',
  's',
  'min',
  'h',
  'day',
  'bps',
  'Kbps',
  'Mbps',
  'Gbps',
  'IOPS',
  'VMs',
  'nodes',
] as const;

export type EngineerSourceKind = (typeof ENGINEER_SOURCE_KINDS)[number];
export type EngineerCaseMode = (typeof ENGINEER_CASE_MODES)[number];
export type EngineerCaseProgress = (typeof ENGINEER_CASE_PROGRESS)[number];
export type EngineerAssessmentStatus = (typeof ENGINEER_ASSESSMENT_STATUSES)[number];
export type EngineerGuideReadiness = (typeof ENGINEER_GUIDE_READINESS)[number];
export type EngineerExecutionResult = (typeof ENGINEER_EXECUTION_RESULTS)[number];
export type EngineerCollectionStatus = (typeof ENGINEER_COLLECTION_STATUSES)[number];
export type EngineerEnvironmentKind = (typeof ENGINEER_ENVIRONMENT_KINDS)[number];
export type EngineerUnit = (typeof ENGINEER_UNITS)[number];

export type EngineerKnownValue =
  | { readonly kind: 'number'; readonly number: number; readonly unit: EngineerUnit }
  | { readonly kind: 'integer'; readonly integer: number; readonly unit?: EngineerUnit }
  | { readonly kind: 'boolean'; readonly boolean: boolean }
  | { readonly kind: 'string'; readonly text: string };

export type EngineerValue =
  | { readonly presence: 'known'; readonly data: EngineerKnownValue }
  | { readonly presence: 'unknown'; readonly reason: string };

export type EngineerCaseAuthContext = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
};

export type EngineerFactProvenance = {
  readonly transport: 'api' | 'browser';
  readonly endpoint: string;
  readonly mapperVersion: string;
  readonly collectedAt: string;
  readonly collector: string;
  readonly menuPath?: readonly string[];
  readonly firmwareVersion?: string;
  readonly latencyMs?: number;
  readonly authPrincipal?: string;
};

export type EngineerObservation = {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly sourceKind: Exclude<EngineerSourceKind, 'derived'>;
  readonly value: EngineerValue;
  readonly target?: string;
  readonly collectedAt?: string;
  readonly collectionStatus: EngineerCollectionStatus;
  readonly evidenceRef?: string;
  readonly freshnessPolicy?: { readonly maxAgeSec: number };
  readonly unknownReason?: string;
  readonly factProvenance?: EngineerFactProvenance;
};

export type EngineerRequirement = {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly sourceKind: Extract<EngineerSourceKind, 'provided' | 'proposed' | 'unknown'>;
  readonly sourceRef: string;
  readonly target?: string;
  readonly constraint?: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly confirmationState: 'unconfirmed' | 'confirmed' | 'rejected';
  readonly acceptanceCriterion: string;
  readonly revision: string;
};

export type EngineerCalculation = {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly sourceKind: Extract<EngineerSourceKind, 'derived' | 'unknown'>;
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly inputRefs: readonly string[];
  readonly unit?: EngineerUnit;
  readonly assumptions: readonly string[];
  readonly result?: EngineerValue;
  readonly unavailableReason?: string;
};

export type EngineerAssessment = {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly requirementRef: string;
  readonly currentRef?: string;
  readonly desiredRef?: string;
  readonly calculationRefs: readonly string[];
  readonly status: EngineerAssessmentStatus;
  readonly reasons: readonly string[];
  readonly nextAction: 'add_information' | 'recollect' | 'design_decision' | 'config_change' | 'none';
};

export type EngineerGuideStep = {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly requirementRefs: readonly string[];
  readonly currentRef?: string;
  readonly proposedRef?: string;
  readonly evidenceRefs: readonly string[];
  readonly citations: readonly string[];
  readonly verify: string;
  readonly stop: string;
  readonly recovery: string;
};

export type EngineerGuide = {
  readonly revision: string;
  readonly digest: string;
  readonly requirementRefs: readonly string[];
  readonly steps: readonly EngineerGuideStep[];
  readonly prerequisites: readonly string[];
  readonly unresolved: readonly string[];
  readonly readiness: EngineerGuideReadiness;
};

export type EngineerEvidence = {
  readonly id: string;
  readonly owner?: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly caseId: string;
  };
  readonly digest: string;
  readonly mediaType: string;
  readonly sanitized: boolean;
  readonly retention: string;
};

export type EngineerExecutionState = {
  readonly result: EngineerExecutionResult;
  readonly reason?: string;
};

export type EngineerCaseDocument = {
  readonly schemaVersion: typeof ENGINEER_CASE_SCHEMA_VERSION;
  readonly caseId: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly actorId?: string;
  readonly mode: EngineerCaseMode;
  readonly product: ProductCode;
  readonly firmware?: string;
  readonly revision: string;
  readonly progress: EngineerCaseProgress;
  readonly environmentKind: EngineerEnvironmentKind;
  readonly synthetic?: boolean;
  readonly originalPresent?: boolean;
  readonly observations: readonly EngineerObservation[];
  readonly requirements: readonly EngineerRequirement[];
  readonly calculations: readonly EngineerCalculation[];
  readonly assessments: readonly EngineerAssessment[];
  readonly guide: EngineerGuide;
  readonly evidence: readonly EngineerEvidence[];
  readonly execution: EngineerExecutionState;
};

export type EngineerCase = EngineerCaseDocument & EngineerCaseAuthContext;

const PRODUCT_CODES = PRODUCTS.map((product) => product.code) as [ProductCode, ...ProductCode[]];

const engineerIdSchema = z.string().regex(ENGINEER_ID_RE).refine(
  (value) => value !== '.' && value !== '..' && !value.includes('..'),
  'INVALID_ID',
);
const isoDateSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(ENGINEER_DIGEST_RE);
const unitSchema = z.enum(ENGINEER_UNITS);
const textSchema = z.string().min(1).max(1024);

const knownValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), number: z.number().finite(), unit: unitSchema }).strict(),
  z.object({ kind: z.literal('integer'), integer: z.number().int().finite(), unit: unitSchema.optional() }).strict(),
  z.object({ kind: z.literal('boolean'), boolean: z.boolean() }).strict(),
  z.object({ kind: z.literal('string'), text: z.string().min(1).max(4096) }).strict(),
]);

export const engineerValueSchema = z.discriminatedUnion('presence', [
  z.object({ presence: z.literal('known'), data: knownValueSchema }).strict(),
  z.object({ presence: z.literal('unknown'), reason: textSchema }).strict(),
]);

const factProvenanceSchema = z.object({
  transport: z.enum(['api', 'browser']),
  endpoint: z.string().min(1).max(512),
  mapperVersion: z.string().min(1).max(64),
  collectedAt: isoDateSchema,
  collector: z.string().min(1).max(64),
  menuPath: z.array(z.string().min(1).max(128)).max(32).optional(),
  firmwareVersion: z.string().min(1).max(128).optional(),
  latencyMs: z.number().finite().positive().optional(),
  authPrincipal: z.string().min(1).max(128).optional(),
}).strict();

const observationSchema = z.object({
  id: engineerIdSchema,
  caseId: engineerIdSchema.optional(),
  projectId: engineerIdSchema.optional(),
  sourceKind: z.enum(['observed', 'provided', 'proposed', 'unknown']),
  value: engineerValueSchema,
  target: z.string().min(1).max(256).optional(),
  collectedAt: isoDateSchema.optional(),
  collectionStatus: z.enum(ENGINEER_COLLECTION_STATUSES),
  evidenceRef: engineerIdSchema.optional(),
  freshnessPolicy: z.object({ maxAgeSec: z.number().int().positive().max(31_536_000) }).strict().optional(),
  unknownReason: textSchema.optional(),
  factProvenance: factProvenanceSchema.optional(),
}).strict().superRefine((observation, context) => {
  addValueKindIssues(observation.sourceKind, observation.value, context, []);
  if (observation.sourceKind === 'unknown' && !observation.unknownReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unknownReason'], message: 'UNKNOWN_REASON_REQUIRED' });
  }
  if (observation.sourceKind === 'observed') {
    if (!observation.factProvenance) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['factProvenance'], message: 'OBSERVED_PROVENANCE_REQUIRED' });
    }
    if (!observation.collectedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['collectedAt'], message: 'OBSERVED_COLLECTED_AT_REQUIRED' });
    }
  }
});

const requirementSchema = z.object({
  id: engineerIdSchema,
  caseId: engineerIdSchema.optional(),
  projectId: engineerIdSchema.optional(),
  sourceKind: z.enum(['provided', 'proposed', 'unknown']),
  sourceRef: z.string().min(1).max(256),
  target: z.string().min(1).max(512).optional(),
  constraint: z.string().min(1).max(1024).optional(),
  priority: z.enum(['high', 'medium', 'low']),
  confirmationState: z.enum(['unconfirmed', 'confirmed', 'rejected']),
  acceptanceCriterion: textSchema,
  revision: engineerIdSchema,
}).strict();

const calculationSchema = z.object({
  id: engineerIdSchema,
  caseId: engineerIdSchema.optional(),
  projectId: engineerIdSchema.optional(),
  sourceKind: z.enum(['derived', 'unknown']),
  formulaId: engineerIdSchema,
  formulaVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  inputRefs: z.array(engineerIdSchema).min(1).max(32),
  unit: unitSchema.optional(),
  assumptions: z.array(z.string().min(1).max(512)).max(32),
  result: engineerValueSchema.optional(),
  unavailableReason: textSchema.optional(),
}).strict().superRefine((calculation, context) => {
  if (calculation.sourceKind === 'derived') {
    if (!calculation.formulaId || !calculation.formulaVersion || calculation.inputRefs.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['formulaId'], message: 'DERIVED_FORMULA_MISSING' });
    }
    if (!calculation.result && !calculation.unavailableReason) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'DERIVED_RESULT_OR_UNAVAILABLE_REQUIRED' });
    }
  }
  if (calculation.result) addValueKindIssues(calculation.sourceKind, calculation.result, context, ['result']);
  if (calculation.sourceKind === 'unknown' && !calculation.unavailableReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unavailableReason'], message: 'UNKNOWN_REASON_REQUIRED' });
  }
  if (calculation.result?.presence === 'known' && calculation.unavailableReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unavailableReason'], message: 'KNOWN_RESULT_AND_UNAVAILABLE' });
  }
});

const assessmentSchema = z.object({
  id: engineerIdSchema,
  caseId: engineerIdSchema.optional(),
  projectId: engineerIdSchema.optional(),
  requirementRef: engineerIdSchema,
  currentRef: engineerIdSchema.optional(),
  desiredRef: engineerIdSchema.optional(),
  calculationRefs: z.array(engineerIdSchema).max(16),
  status: z.enum(ENGINEER_ASSESSMENT_STATUSES),
  reasons: z.array(z.string().min(1).max(512)).min(1).max(16),
  nextAction: z.enum(['add_information', 'recollect', 'design_decision', 'config_change', 'none']),
}).strict();

const guideStepSchema = z.object({
  id: engineerIdSchema,
  order: z.number().int().positive(),
  title: z.string().min(1).max(256),
  requirementRefs: z.array(engineerIdSchema).max(16),
  currentRef: engineerIdSchema.optional(),
  proposedRef: engineerIdSchema.optional(),
  evidenceRefs: z.array(engineerIdSchema).max(16),
  citations: z.array(z.string().min(1).max(256)).max(16),
  verify: textSchema,
  stop: textSchema,
  recovery: textSchema,
}).strict();

const guideSchema = z.object({
  revision: engineerIdSchema,
  digest: digestSchema,
  requirementRefs: z.array(engineerIdSchema).max(64),
  steps: z.array(guideStepSchema).max(64),
  prerequisites: z.array(z.string().min(1).max(512)).max(32),
  unresolved: z.array(z.string().min(1).max(512)).max(64),
  readiness: z.enum(ENGINEER_GUIDE_READINESS),
}).strict();

const evidenceSchema = z.object({
  id: engineerIdSchema,
  owner: z.object({
    tenantId: engineerIdSchema,
    projectId: engineerIdSchema,
    caseId: engineerIdSchema,
  }).strict().optional(),
  digest: digestSchema,
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u),
  sanitized: z.boolean(),
  retention: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
}).strict();

const executionSchema = z.object({
  result: z.enum(ENGINEER_EXECUTION_RESULTS),
  reason: z.string().min(1).max(512).optional(),
}).strict();

export const engineerCaseDocumentSchema: z.ZodType<EngineerCaseDocument> = z.object({
  schemaVersion: z.literal(ENGINEER_CASE_SCHEMA_VERSION),
  caseId: engineerIdSchema,
  tenantId: engineerIdSchema.optional(),
  projectId: engineerIdSchema.optional(),
  actorId: engineerIdSchema.optional(),
  mode: z.enum(ENGINEER_CASE_MODES),
  product: z.enum(PRODUCT_CODES),
  firmware: z.string().min(1).max(128).optional(),
  revision: engineerIdSchema,
  progress: z.enum(ENGINEER_CASE_PROGRESS),
  environmentKind: z.enum(ENGINEER_ENVIRONMENT_KINDS),
  synthetic: z.boolean().optional(),
  originalPresent: z.boolean().optional(),
  observations: z.array(observationSchema).max(256),
  requirements: z.array(requirementSchema).max(256),
  calculations: z.array(calculationSchema).max(256),
  assessments: z.array(assessmentSchema).max(256),
  guide: guideSchema,
  evidence: z.array(evidenceSchema).max(256),
  execution: executionSchema,
}).strict().superRefine((document, context) => {
  if (document.synthetic === true && document.environmentKind === 'live') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['environmentKind'], message: 'SYNTHETIC_MARKED_LIVE' });
  }

  const ids = new Map<string, string>();
  const remember = (id: string, path: Array<string | number>) => {
    const previous = ids.get(id);
    if (previous) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: `DUPLICATE_ID:${previous}` });
      return;
    }
    ids.set(id, path.join('.'));
  };

  document.observations.forEach((item, index) => remember(item.id, ['observations', index, 'id']));
  document.requirements.forEach((item, index) => remember(item.id, ['requirements', index, 'id']));
  document.calculations.forEach((item, index) => remember(item.id, ['calculations', index, 'id']));
  document.assessments.forEach((item, index) => remember(item.id, ['assessments', index, 'id']));
  document.evidence.forEach((item, index) => remember(item.id, ['evidence', index, 'id']));
  document.guide.steps.forEach((item, index) => remember(item.id, ['guide', 'steps', index, 'id']));

  const observationIds = new Set(document.observations.map((item) => item.id));
  const requirementIds = new Set(document.requirements.map((item) => item.id));
  const calculationIds = new Set(document.calculations.map((item) => item.id));
  const valueIds = new Set([...observationIds, ...calculationIds]);
  const evidenceIds = new Set(document.evidence.map((item) => item.id));

  const requireRef = (id: string | undefined, allowed: Set<string>, path: Array<string | number>, code: string) => {
    if (id === undefined) return;
    if (!allowed.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path, message: code });
  };

  document.observations.forEach((item, index) => {
    addScopeIssues(document, item, context, ['observations', index]);
    requireRef(item.evidenceRef, evidenceIds, ['observations', index, 'evidenceRef'], 'UNKNOWN_ID_REF');
    if (item.sourceKind === 'observed') {
      if (document.environmentKind !== 'live') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index, 'sourceKind'],
          message: 'FIXTURE_MARKED_OBSERVED',
        });
      }
      if (document.originalPresent === false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index, 'sourceKind'],
          message: 'MISSING_ORIGINAL_MARKED_OBSERVED',
        });
      }
    }
  });
  document.requirements.forEach((item, index) => addScopeIssues(document, item, context, ['requirements', index]));
  document.calculations.forEach((item, index) => {
    addScopeIssues(document, item, context, ['calculations', index]);
    item.inputRefs.forEach((ref, refIndex) => {
      requireRef(ref, valueIds, ['calculations', index, 'inputRefs', refIndex], 'UNKNOWN_ID_REF');
    });
  });
  document.assessments.forEach((item, index) => {
    addScopeIssues(document, item, context, ['assessments', index]);
    requireRef(item.requirementRef, requirementIds, ['assessments', index, 'requirementRef'], 'UNKNOWN_ID_REF');
    requireRef(item.currentRef, valueIds, ['assessments', index, 'currentRef'], 'UNKNOWN_ID_REF');
    requireRef(item.desiredRef, valueIds, ['assessments', index, 'desiredRef'], 'UNKNOWN_ID_REF');
    item.calculationRefs.forEach((ref, refIndex) => {
      requireRef(ref, calculationIds, ['assessments', index, 'calculationRefs', refIndex], 'UNKNOWN_ID_REF');
    });
  });
  document.guide.requirementRefs.forEach((ref, index) => {
    requireRef(ref, requirementIds, ['guide', 'requirementRefs', index], 'UNKNOWN_ID_REF');
  });
  const stepOrders = new Set<number>();
  document.guide.steps.forEach((step, index) => {
    if (stepOrders.has(step.order)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['guide', 'steps', index, 'order'], message: 'DUPLICATE_ID' });
    }
    stepOrders.add(step.order);
    step.requirementRefs.forEach((ref, refIndex) => {
      requireRef(ref, requirementIds, ['guide', 'steps', index, 'requirementRefs', refIndex], 'UNKNOWN_ID_REF');
    });
    requireRef(step.currentRef, valueIds, ['guide', 'steps', index, 'currentRef'], 'UNKNOWN_ID_REF');
    requireRef(step.proposedRef, valueIds, ['guide', 'steps', index, 'proposedRef'], 'UNKNOWN_ID_REF');
    step.evidenceRefs.forEach((ref, refIndex) => {
      requireRef(ref, evidenceIds, ['guide', 'steps', index, 'evidenceRefs', refIndex], 'UNKNOWN_ID_REF');
    });
  });
  document.evidence.forEach((item, index) => {
    if (!item.owner) return;
    if (item.owner.caseId !== document.caseId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence', index, 'owner', 'caseId'], message: 'CROSS_CASE_REF' });
    }
    if (document.projectId && item.owner.projectId !== document.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'owner', 'projectId'],
        message: 'CROSS_PROJECT_REF',
      });
    }
    if (document.tenantId && item.owner.tenantId !== document.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', index, 'owner', 'tenantId'],
        message: 'CROSS_PROJECT_REF',
      });
    }
  });
});

function addScopeIssues(
  document: EngineerCaseDocument,
  item: { readonly caseId?: string; readonly projectId?: string },
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (item.caseId && item.caseId !== document.caseId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'caseId'], message: 'CROSS_CASE_REF' });
  }
  if (item.projectId && document.projectId && item.projectId !== document.projectId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'projectId'], message: 'CROSS_PROJECT_REF' });
  }
}

function addValueKindIssues(
  sourceKind: EngineerSourceKind,
  value: EngineerValue,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (sourceKind === 'unknown') {
    if (value.presence !== 'unknown') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'value'], message: 'UNKNOWN_COERCED' });
      return;
    }
    return;
  }
  if (value.presence !== 'known') {
    if (sourceKind !== 'derived') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'value'], message: 'KNOWN_VALUE_REQUIRED' });
    }
  }
}

export function isEngineerCaseAuthContext(input: unknown): input is EngineerCaseAuthContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return [record.tenantId, record.projectId, record.actorId].every((value) => (
    typeof value === 'string' && ENGINEER_ID_RE.test(value) && value !== '.' && value !== '..' && !value.includes('..')
  ));
}

export function serializeEngineerValue(value: EngineerValue): {
  readonly presence: EngineerValue['presence'];
  readonly reason?: string;
  readonly value: null | EngineerKnownValue;
} {
  if (value.presence === 'unknown') {
    return { presence: 'unknown', value: null, reason: value.reason };
  }
  return { presence: 'known', value: value.data };
}

export function parseEngineerCaseDocument(source: string): EngineerCaseDocument {
  return parseRuntimeJson(source, {
    schema: engineerCaseDocumentSchema,
    schemaName: 'engineer-case.v1',
    policy: 'deny',
    expectedVersion: ENGINEER_CASE_SCHEMA_VERSION,
    versionPath: ['schemaVersion'],
    uniqueCollections: [
      { path: ['observations'], key: 'id' },
      { path: ['requirements'], key: 'id' },
      { path: ['calculations'], key: 'id' },
      { path: ['assessments'], key: 'id' },
      { path: ['evidence'], key: 'id' },
      { path: ['guide', 'steps'], key: 'id' },
    ],
  });
}

export function runtimeSchemaIssueCode(error: unknown): string | undefined {
  if (!(error instanceof RuntimeSchemaError)) return undefined;
  return error.issues[0]?.code;
}
