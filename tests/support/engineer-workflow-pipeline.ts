import { collectInventory, type HciClient, type HciInventory, type HttpJsonResult } from '../../packages/sangfor-hci-client/src/index.js';
import { summarizeHciHealth } from '../../packages/sangfor-hci-client/src/ops-monitor.js';
import {
  collectRequiredObservations,
  HCI_E03B_REQUIRED_FIELDS,
} from '../../packages/sangfor-hci-client/src/required-observations.js';
import {
  bindRequiredObservationsToCase,
  buildHciCollectionSnapshot,
} from '../../packages/sangfor-config-state/src/index.js';
import { assembleEngineerCase, type EngineerCaseAssembly } from '../../packages/sangfor-planner/src/engineer-case.js';
import {
  assessEngineerCase,
  type EngineerAssessmentBinding,
  type EngineerAssessmentResult,
  type EngineerCaseCoverage,
} from '../../packages/sangfor-planner/src/engineer-assessment.js';
import { buildEngineerGuide, type EngineerGuideBuildResult } from '../../packages/sangfor-planner/src/engineer-guide.js';
import { ingestEngineerRequirements } from '../../packages/sangfor-product-adapters/src/engineer-requirement-ingest.js';
import {
  exportEngineerGuide,
  formatStoredEngineerValue,
  type EngineerGuideExportResult,
} from '../../packages/sangfor-product-adapters/src/engineer-guide-export.js';
import type { ExcelRequirementRow } from '../../packages/sangfor-product-adapters/src/types.js';
import {
  evaluateEngineerFormula,
  operandFromObservation,
} from '../../packages/sangfor-sizing/src/engineer-calculations.js';
import { prepareEngineerCaseForPersistence } from '../../packages/sangfor-authority/src/engineer-case-persistence.js';
import type { EngineerCaseSaveRequest, EngineerCaseSaveResult } from '../../packages/sangfor-authority/src/authority-store-contracts.js';
import { projectEngineerCaseReview, type EngineerCaseReviewView } from '../../apps/operator-console/src/engineer-case-review.js';
import { projectEngineerGuidePreview, type EngineerGuidePreview } from '../../apps/operator-console/src/engineer-case-guide-preview.js';
import {
  computeEngineerGuideDigest,
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerCalculation,
  type EngineerCase,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerCaseMode,
  type EngineerGuideStep,
  type EngineerObservation,
  type EngineerRequirement,
} from '../../packages/shared/src/engineer-case-contract.js';
import {
  evaluateEngineerFieldAcceptance,
  type EngineerFieldAcceptanceDecision,
} from '../../packages/shared/src/engineer-field-acceptance.js';
import type { ProductCode } from '../../packages/shared/src/index.js';

const WHEN = '2026-09-09T00:00:00.000Z';
const CAPACITY_FORMULA_IDS = new Set([
  'confirmed-remaining-capacity',
  'confirmed-utilization-ratio',
  'demand-headroom',
]);

export type EngineerWorkflowStepId =
  | 'collect'
  | 'requirements'
  | 'calc'
  | 'assess'
  | 'guide'
  | 'persist'
  | 'export';

export type EngineerWorkflowStep = {
  readonly id: EngineerWorkflowStepId;
  readonly exportName: string;
  readonly status: 'ran' | 'unavailable' | 'refused' | 'failed';
  readonly reason?: string;
};

export type EngineerWorkflowPersist = (input: EngineerCaseSaveRequest) => Promise<EngineerCaseSaveResult>;

export type EngineerWorkflowInput = {
  readonly auth: EngineerCaseAuthContext;
  readonly caseId: string;
  readonly mode: EngineerCaseMode;
  readonly product: ProductCode;
  readonly firmware?: string;
  readonly revision: string;
  readonly requestId: string;
  readonly expectedRevision?: string;
  readonly inventoryClient?: Pick<HciClient, 'request'>;
  readonly skipCollect?: boolean;
  readonly requirementRows?: readonly ExcelRequirementRow[];
  readonly requirementTexts?: readonly string[];
  readonly providedObservations?: readonly EngineerObservation[];
  readonly persist?: EngineerWorkflowPersist;
  readonly exportRoot: string;
  readonly exportPath?: string;
  readonly originalPresent?: boolean;
};

export type FieldTrack = {
  readonly id: string;
  readonly sourceKind: string;
  readonly status: 'collected' | 'provided' | 'missing' | 'unknown' | 'unavailable';
};

export type EngineerWorkflowResult = {
  readonly fabricatedPass: false;
  readonly fieldAccepted: false;
  readonly liveProof: false;
  readonly completedNormally: boolean;
  readonly collectFailed: boolean;
  readonly skippedCountedAsPass: false;
  readonly steps: readonly EngineerWorkflowStep[];
  readonly inventory?: HciInventory;
  readonly healthScope?: string;
  readonly healthVerdict?: string;
  readonly assembled?: EngineerCaseAssembly;
  readonly document?: EngineerCase;
  readonly persist?: EngineerCaseSaveResult;
  readonly export?: EngineerGuideExportResult;
  readonly review?: EngineerCaseReviewView;
  readonly preview?: EngineerGuidePreview;
  readonly fieldAcceptance: EngineerFieldAcceptanceDecision;
  readonly coverage?: EngineerCaseCoverage;
  readonly tracking: {
    readonly requiredFields: readonly FieldTrack[];
    readonly requirementIds: readonly string[];
    readonly requirementTrackingRate: number;
    readonly executableSteps: number;
    readonly executableStepTrackingRate: number;
    readonly fabricatedPassCount: 0;
  };
  readonly unresolved: readonly string[];
};

function response(json: unknown, status = 200): HttpJsonResult {
  return { json, status, text: JSON.stringify(json) };
}

export function fixtureInventoryClient(payload: {
  readonly volumes: unknown[];
  readonly servers: unknown[];
  readonly images: unknown[];
}, status: Partial<Record<'volume' | 'compute' | 'image', number>> = {}): Pick<HciClient, 'request'> {
  return {
    async request(service) {
      if (service === 'volume') return response({ volumes: payload.volumes }, status.volume ?? 200);
      if (service === 'compute') return response({ servers: payload.servers }, status.compute ?? 200);
      if (service === 'image') return response({ images: payload.images }, status.image ?? 200);
      throw new Error(`unexpected service ${service}`);
    },
  };
}

function oracleCapacityObservations(auth: EngineerCaseAuthContext, caseId: string): EngineerObservation[] {
  return [
    {
      id: 'obs-total',
      caseId,
      projectId: auth.projectId,
      sourceKind: 'provided',
      target: 'provided-total-capacity',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-e11-1',
      value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
    },
    {
      id: 'obs-used',
      caseId,
      projectId: auth.projectId,
      sourceKind: 'provided',
      target: 'provided-used-capacity',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-e11-1',
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
    },
    {
      id: 'obs-demand',
      caseId,
      projectId: auth.projectId,
      sourceKind: 'provided',
      target: 'provided-demand',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-e11-1',
      value: { presence: 'known', data: { kind: 'number', number: 20, unit: 'GiB' } },
    },
  ];
}

function step(
  id: EngineerWorkflowStepId,
  exportName: string,
  status: EngineerWorkflowStep['status'],
  reason?: string,
): EngineerWorkflowStep {
  return reason ? { id, exportName, status, reason } : { id, exportName, status };
}

function placeholderGuide(requirementIds: readonly string[], unresolved: readonly string[]) {
  const fields = {
    revision: 'guide-draft',
    requirementRefs: requirementIds,
    steps: [] as EngineerCaseDocument['guide']['steps'],
    prerequisites: ['fixture path; live device write is out of scope'],
    unresolved,
    readiness: 'draft' as const,
  };
  return { ...fields, digest: computeEngineerGuideDigest(fields) };
}

function assessmentBindings(
  requirements: readonly EngineerRequirement[],
  calculations: readonly EngineerCalculation[],
): EngineerAssessmentBinding[] {
  const capacityCalcIds = calculations
    .filter((item) => CAPACITY_FORMULA_IDS.has(item.formulaId))
    .map((item) => item.id);
  return requirements.map((requirement) => {
    const text = `${requirement.target ?? ''} ${requirement.constraint ?? ''} ${requirement.acceptanceCriterion}`.toLowerCase();
    if (/headroom|utilization|여유|사용률|remaining|잔여|usable storage|capacity/.test(text)) {
      return {
        requirementId: requirement.id,
        fieldId: 'storage_usable_capacity' as const,
        calculationRefs: capacityCalcIds,
      };
    }
    if (/\bha\b|고가용/.test(text)) {
      return { requirementId: requirement.id, fieldId: 'ha_status' as const };
    }
    return { requirementId: requirement.id };
  });
}

function trackedGuideStep(stepView: EngineerGuideStep): boolean {
  return stepView.requirementRefs.length > 0
    && stepView.verify.trim().length > 0
    && stepView.stop.trim().length > 0
    && stepView.recovery.trim().length > 0;
}

function requirementTrackingRate(
  requirements: readonly EngineerRequirement[],
  assessments: readonly { readonly requirementRef: string }[],
): number {
  if (requirements.length === 0) return 0;
  const assessed = new Set(assessments.map((item) => item.requirementRef));
  return requirements.filter((item) => assessed.has(item.id)).length / requirements.length;
}

function executableStepTrackingRate(steps: readonly EngineerGuideStep[]): number {
  if (steps.length === 0) return 0;
  return steps.filter(trackedGuideStep).length / steps.length;
}

function trackRequiredFields(input: {
  readonly mode: EngineerCaseMode;
  readonly inventory?: HciInventory;
  readonly providedObservations: readonly EngineerObservation[];
  readonly requiredBound: ReturnType<typeof bindRequiredObservationsToCase>;
}): FieldTrack[] {
  if (input.mode === 'new') {
    const providedIds = new Set(input.providedObservations.map((item) => item.target ?? item.id));
    return [
      ...['node_count', 'cpu_per_node_cores', 'ram_per_node_gib', 'usable_storage_tib', 'ha_intent', 'firmware_requested']
        .map((id) => ({
          id,
          sourceKind: id === 'ha_intent' ? 'proposed' : 'provided',
          status: (providedIds.has(id) || id === 'firmware_requested' ? 'provided' : 'missing') as FieldTrack['status'],
        })),
      { id: 'requirements', sourceKind: 'provided', status: 'provided' },
      { id: 'official_bom', sourceKind: 'unknown', status: 'unknown' },
      ...input.requiredBound.observations.map((item) => ({
        id: item.id.replace(/^obs-/, ''),
        sourceKind: item.sourceKind,
        status: item.value.presence === 'known' ? 'provided' as const : 'unknown' as const,
      })),
    ];
  }
  const inventoryFields = (input.inventory?.fields ?? []).map((field) => ({
    id: field.id,
    sourceKind: field.sourceKind,
    status: field.availability === 'collected'
      ? 'collected' as const
      : field.availability === 'provided'
        ? 'provided' as const
        : field.availability === 'missing'
          ? 'missing' as const
          : 'unknown' as const,
  }));
  if (inventoryFields.length > 0) {
    return [
      ...inventoryFields,
      { id: 'requirements', sourceKind: 'provided', status: 'provided' },
    ];
  }
  return [
    ...HCI_E03B_REQUIRED_FIELDS.map((id) => ({ id, sourceKind: 'unknown', status: 'unknown' as const })),
    { id: 'requirements', sourceKind: 'provided', status: 'provided' },
  ];
}

function baseResult(partial: {
  steps: EngineerWorkflowStep[];
  collectFailed: boolean;
  inventory?: HciInventory;
  healthScope?: string;
  healthVerdict?: string;
  assembled?: EngineerCaseAssembly;
  document?: EngineerCase;
  persist?: EngineerCaseSaveResult;
  export?: EngineerGuideExportResult;
  review?: EngineerCaseReviewView;
  preview?: EngineerGuidePreview;
  coverage?: EngineerCaseCoverage;
  tracking?: EngineerWorkflowResult['tracking'];
  unresolved?: readonly string[];
}): EngineerWorkflowResult {
  const document = partial.document;
  return {
    fabricatedPass: false,
    fieldAccepted: false,
    liveProof: false,
    fieldAcceptance: evaluateEngineerFieldAcceptance({
      environmentKind: document?.environmentKind,
      synthetic: document?.synthetic,
      originalPresent: document?.originalPresent,
      guideReadiness: document?.guide.readiness,
      wordExportOk: partial.export?.ok === true,
      workflowCompletedNormally: false,
    }),
    completedNormally: false,
    collectFailed: partial.collectFailed,
    skippedCountedAsPass: false,
    steps: partial.steps,
    inventory: partial.inventory,
    healthScope: partial.healthScope,
    healthVerdict: partial.healthVerdict,
    assembled: partial.assembled,
    document: partial.document,
    persist: partial.persist,
    export: partial.export,
    review: partial.review,
    preview: partial.preview,
    coverage: partial.coverage,
    tracking: partial.tracking ?? {
      requiredFields: [],
      requirementIds: [],
      requirementTrackingRate: 0,
      executableSteps: 0,
      executableStepTrackingRate: 0,
      fabricatedPassCount: 0,
    },
    unresolved: partial.unresolved ?? [],
  };
}

export async function runEngineerWorkflow(input: EngineerWorkflowInput): Promise<EngineerWorkflowResult> {
  const steps: EngineerWorkflowStep[] = [];
  let inventory: HciInventory | undefined;
  let collectFailed = false;
  let healthScope: string | undefined;
  let healthVerdict: string | undefined;

  if (input.skipCollect || !input.inventoryClient) {
    steps.push(step('collect', 'collectInventory', 'unavailable', input.skipCollect
      ? 'new-build does not call device collect'
      : 'inventory client was not supplied'));
  } else {
    inventory = await collectInventory(input.inventoryClient, { collectedAt: WHEN });
    collectFailed = Object.values(inventory.collection).some((item) => item.status === 'failed');
    const health = summarizeHciHealth(inventory);
    healthScope = health.scope;
    healthVerdict = health.verdict;
    steps.push(step('collect', 'collectInventory', collectFailed ? 'failed' : 'ran', collectFailed
      ? 'one or more inventory surfaces failed'
      : undefined));
  }

  const ingested = ingestEngineerRequirements({
    mode: input.mode,
    caseId: input.caseId,
    projectId: input.auth.projectId,
    revision: 'reqrev-1',
    rows: input.requirementRows,
    texts: input.requirementTexts,
    originalPresent: input.originalPresent === true,
  });
  if (!ingested.ok) {
    steps.push(step('requirements', 'ingestEngineerRequirements', 'refused', ingested.code));
    return baseResult({ steps, collectFailed, inventory, healthScope, healthVerdict });
  }
  steps.push(step('requirements', 'ingestEngineerRequirements', 'ran'));
  const requirements: readonly EngineerRequirement[] = ingested.requirements;

  const required = inventory?.requiredObservations ?? collectRequiredObservations();
  const snapshot = inventory
    ? buildHciCollectionSnapshot(inventory, {
      caseId: input.caseId,
      projectId: input.auth.projectId,
      environmentKind: 'fixture',
      originalPresent: input.originalPresent === true,
    })
    : undefined;
  const requiredBound = snapshot?.requiredObservations ?? bindRequiredObservationsToCase(required, {
    caseId: input.caseId,
    projectId: input.auth.projectId,
  });
  const snapshotObservations = snapshot?.observations ?? [];
  const provided = input.providedObservations ?? (input.mode === 'existing' ? oracleCapacityObservations(input.auth, input.caseId) : []);
  const observations = [...snapshotObservations, ...provided, ...requiredBound.observations];

  const total = observations.find((item) => item.id === 'obs-total');
  const used = observations.find((item) => item.id === 'obs-used');
  const demand = observations.find((item) => item.id === 'obs-demand');
  const calculations: EngineerCalculation[] = [];
  if (total && used) {
    calculations.push(evaluateEngineerFormula({
      id: 'calc-remaining',
      caseId: input.caseId,
      projectId: input.auth.projectId,
      formulaId: 'confirmed-remaining-capacity',
      roles: { total: operandFromObservation(total), used: operandFromObservation(used) },
      now: WHEN,
    }));
    calculations.push(evaluateEngineerFormula({
      id: 'calc-utilization',
      caseId: input.caseId,
      projectId: input.auth.projectId,
      formulaId: 'confirmed-utilization-ratio',
      roles: { total: operandFromObservation(total), used: operandFromObservation(used) },
      now: WHEN,
    }));
    if (demand) {
      calculations.push(evaluateEngineerFormula({
        id: 'calc-headroom',
        caseId: input.caseId,
        projectId: input.auth.projectId,
        formulaId: 'demand-headroom',
        roles: {
          total: operandFromObservation(total),
          used: operandFromObservation(used),
          demand: operandFromObservation(demand),
        },
        now: WHEN,
      }));
    }
    steps.push(step('calc', 'evaluateEngineerFormula', 'ran'));
  } else {
    steps.push(step('calc', 'evaluateEngineerFormula', 'unavailable', 'total/used provided operands were not supplied'));
  }

  const draftUnresolved = [
    ...ingested.questions.map((item) => item.message),
    ...HCI_E03B_REQUIRED_FIELDS.map((field) => `${field} is unknown`),
    ...(collectFailed ? ['collection failed; guide output is not a normal completion'] : []),
    ...(input.mode === 'new' ? ['provided specs are not observed device values'] : []),
    'review_ready is not field_accepted',
  ].filter((text, index, all) => all.indexOf(text) === index);

  const draft: EngineerCaseDocument = {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: input.caseId,
    mode: input.mode,
    product: input.product,
    ...(input.firmware ? { firmware: input.firmware } : {}),
    revision: input.revision,
    progress: collectFailed ? 'inputs_pending' : 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: input.originalPresent === true,
    observations,
    requirements,
    calculations,
    assessments: [],
    guide: placeholderGuide(requirements.map((item) => item.id), draftUnresolved),
    evidence: [{
      id: 'ev-e11-1',
      owner: { tenantId: input.auth.tenantId, projectId: input.auth.projectId, caseId: input.caseId },
      digest: 'ab'.repeat(32),
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started', reason: 'E11 harness does not execute device changes' },
  };

  let assessed: EngineerAssessmentResult;
  try {
    assessed = assessEngineerCase({
      document: draft,
      auth: input.auth,
      caseRevision: input.revision,
      now: WHEN,
      requiredObservations: required,
      bindings: assessmentBindings(requirements, calculations),
      inventory: inventory
        ? { servers: inventory.servers, volumes: inventory.volumes }
        : undefined,
      hciHealthVerdict: healthVerdict as 'PASS' | 'FAIL' | 'INDETERMINATE' | undefined,
    });
  } catch (error) {
    steps.push(step('assess', 'assessEngineerCase', 'failed', error instanceof Error ? error.message : 'assess threw'));
    return baseResult({ steps, collectFailed, inventory, healthScope, healthVerdict });
  }
  if (!assessed.ok) {
    steps.push(step('assess', 'assessEngineerCase', 'failed', assessed.code));
    return baseResult({ steps, collectFailed, inventory, healthScope, healthVerdict });
  }
  steps.push(step('assess', 'assessEngineerCase', 'ran'));

  const assessedDocument: EngineerCaseDocument = assessed.assembled.ok
    ? assessed.assembled.value
    : {
      ...draft,
      calculations: assessed.calculations,
      assessments: assessed.assessments,
      progress: 'assessment_ready',
    };

  let built: EngineerGuideBuildResult;
  try {
    built = buildEngineerGuide({
      document: assessedDocument,
      auth: input.auth,
      caseRevision: input.revision,
      assessments: assessed.assessments,
      calculations: assessed.calculations,
      hciHealthVerdict: healthVerdict as 'PASS' | 'FAIL' | 'INDETERMINATE' | undefined,
    });
  } catch (error) {
    steps.push(step('guide', 'buildEngineerGuide', 'failed', error instanceof Error ? error.message : 'guide threw'));
    return baseResult({
      steps,
      collectFailed,
      inventory,
      healthScope,
      healthVerdict,
      coverage: assessed.coverage,
    });
  }
  if (!built.ok) {
    steps.push(step('guide', 'buildEngineerGuide', 'failed', built.code));
    return baseResult({
      steps,
      collectFailed,
      inventory,
      healthScope,
      healthVerdict,
      coverage: assessed.coverage,
    });
  }
  steps.push(step('guide', 'buildEngineerGuide', 'ran'));

  let guideDocument = built.document;
  if (collectFailed) {
    const unresolved = [
      ...guideDocument.guide.unresolved,
      'collection failed; guide output is not a normal completion',
    ].filter((text, index, all) => all.indexOf(text) === index);
    const fields = {
      revision: guideDocument.guide.revision,
      requirementRefs: guideDocument.guide.requirementRefs,
      steps: guideDocument.guide.steps,
      prerequisites: guideDocument.guide.prerequisites,
      unresolved,
      readiness: 'blocked' as const,
    };
    guideDocument = {
      ...guideDocument,
      progress: 'inputs_pending',
      guide: { ...fields, digest: computeEngineerGuideDigest(fields) },
    };
  }

  const assembled = assembleEngineerCase(guideDocument, input.auth);
  if (!assembled.ok) {
    steps.push(step('persist', 'saveEngineerCase', 'refused', assembled.issues.map((item) => item.code).join(',')));
    return baseResult({
      steps,
      collectFailed,
      inventory,
      healthScope,
      healthVerdict,
      assembled,
      coverage: assessed.coverage,
    });
  }

  const prepared = prepareEngineerCaseForPersistence(guideDocument, input.auth);
  if (!prepared.ok) {
    steps.push(step('persist', 'saveEngineerCase', 'refused', prepared.issues.map((item) => item.code).join(',')));
    return baseResult({
      steps,
      collectFailed,
      inventory,
      healthScope,
      healthVerdict,
      assembled,
      coverage: assessed.coverage,
    });
  }

  if (!input.persist) {
    steps.push(step('persist', 'saveEngineerCase', 'unavailable', 'PERSIST_INJECT_REQUIRED'));
    return baseResult({
      steps,
      collectFailed,
      inventory,
      healthScope,
      healthVerdict,
      assembled,
      document: prepared.value.value,
      coverage: assessed.coverage,
    });
  }
  const persist = await input.persist({
    auth: input.auth,
    document: guideDocument,
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
  });
  steps.push(persist.ok
    ? step('persist', 'saveEngineerCase', 'ran')
    : step('persist', 'saveEngineerCase', persist.code === 'REVISION_CONFLICT' ? 'refused' : 'failed', persist.ok ? undefined : persist.code));

  const persistedDocument = prepared.value.value;
  const exported = persist.ok
    ? await exportEngineerGuide({
      document: persistedDocument,
      auth: input.auth,
      outputPath: input.exportPath ?? `${input.caseId}-${persistedDocument.guide.revision}.docx`,
      outputRoot: input.exportRoot,
    })
    : undefined;
  if (exported) {
    steps.push(exported.ok
      ? step('export', 'exportEngineerGuide', 'ran')
      : step('export', 'exportEngineerGuide', 'refused', exported.ok ? undefined : exported.code));
  } else {
    steps.push(step('export', 'exportEngineerGuide', 'unavailable', 'persist did not succeed'));
  }

  const review = projectEngineerCaseReview(persistedDocument, persist.ok ? 'saved' : 'unsaved');
  const preview = projectEngineerGuidePreview(persistedDocument, persist.ok ? 'saved' : 'unsaved');
  const requiredFields = trackRequiredFields({
    mode: input.mode,
    inventory,
    providedObservations: provided,
    requiredBound,
  });
  const unresolved = [
    ...draftUnresolved,
    ...built.blockers,
    ...built.guide.unresolved,
  ].filter((text, index, all) => all.indexOf(text) === index).slice(0, 64);

  const completedNormally = !collectFailed
    && steps.every((item) => item.status === 'ran')
    && persist.ok
    && exported?.ok === true
    && unresolved.filter((item) => item !== 'review_ready is not field_accepted').length === 0
    && review.complete === false
    && preview.fieldAccepted === false
    && assembled.guideReadyGranted === false
    && persist.guideReadyGranted === false
    && persistedDocument.guide.readiness !== 'review_ready';

  const fieldAcceptance = evaluateEngineerFieldAcceptance({
    environmentKind: persistedDocument.environmentKind,
    synthetic: persistedDocument.synthetic,
    originalPresent: persistedDocument.originalPresent,
    guideReadiness: persistedDocument.guide.readiness,
    wordExportOk: exported?.ok === true,
    workflowCompletedNormally: completedNormally,
  });

  return {
    fabricatedPass: false,
    fieldAccepted: false,
    liveProof: false,
    fieldAcceptance,
    completedNormally,
    collectFailed,
    skippedCountedAsPass: false,
    steps,
    inventory,
    healthScope,
    healthVerdict,
    assembled,
    document: persistedDocument,
    persist,
    export: exported,
    review,
    preview,
    coverage: assessed.coverage,
    tracking: {
      requiredFields,
      requirementIds: requirements.map((item) => item.id),
      requirementTrackingRate: requirementTrackingRate(requirements, assessed.assessments),
      executableSteps: persistedDocument.guide.steps.length,
      executableStepTrackingRate: executableStepTrackingRate(persistedDocument.guide.steps),
      fabricatedPassCount: 0,
    },
    unresolved,
  };
}

export function storedNumber(document: EngineerCaseDocument, id: string): string | undefined {
  const calculation = document.calculations.find((item) => item.id === id);
  if (!calculation?.result) return undefined;
  return formatStoredEngineerValue(calculation.result);
}
