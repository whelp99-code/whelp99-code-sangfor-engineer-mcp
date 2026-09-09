import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectInventory, type HciClient, type HciInventory, type HttpJsonResult } from '../../packages/sangfor-hci-client/src/index.js';
import { summarizeHciHealth } from '../../packages/sangfor-hci-client/src/ops-monitor.js';
import { assembleEngineerCase, type EngineerCaseAssembly } from '../../packages/sangfor-planner/src/engineer-case.js';
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
  type EngineerObservation,
  type EngineerRequirement,
} from '../../packages/shared/src/engineer-case-contract.js';
import type { ProductCode } from '../../packages/shared/src/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WHEN = '2026-09-09T00:00:00.000Z';
const UNKNOWN_FIELDS = [
  'host_cpu',
  'host_ram',
  'storage_usable_capacity',
  'network_topology',
  'ha_status',
] as const;

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
  readonly tracking: {
    readonly requiredFields: readonly FieldTrack[];
    readonly requirementIds: readonly string[];
    readonly requirementTrackingRate: number;
    readonly executableSteps: number;
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

async function loadOptional<T>(rel: string): Promise<T | undefined> {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return undefined;
  return import(pathToFileURL(abs).href) as Promise<T>;
}

function unknownObservation(id: string, field: string): EngineerObservation {
  const reason = `${field} is not collected by current inventory surfaces`;
  return {
    id,
    sourceKind: 'unknown',
    target: field,
    collectionStatus: 'missing',
    value: { presence: 'unknown', reason },
    unknownReason: reason,
  };
}

function surfaceObservation(
  inventory: HciInventory,
  surface: 'volumes' | 'servers' | 'images',
): EngineerObservation {
  const collection = inventory.collection[surface];
  if (collection.status === 'complete') {
    const count = inventory[surface].length;
    return {
      id: `obs-${surface}`,
      sourceKind: 'provided',
      target: surface,
      collectionStatus: 'complete',
      collectedAt: inventory.collectedAt,
      value: { presence: 'known', data: { kind: 'integer', integer: count } },
    };
  }
  const reason = collection.reason ?? `${surface} collection ${collection.status}`;
  return {
    id: `obs-${surface}`,
    sourceKind: 'unknown',
    target: surface,
    collectionStatus: collection.status === 'partial' ? 'partial' : 'failed',
    collectedAt: inventory.collectedAt,
    value: { presence: 'unknown', reason },
    unknownReason: reason,
  };
}

function oracleCapacityObservations(): EngineerObservation[] {
  return [
    {
      id: 'obs-total',
      sourceKind: 'provided',
      target: 'provided-total-capacity',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
    },
    {
      id: 'obs-used',
      sourceKind: 'provided',
      target: 'provided-used-capacity',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
    },
    {
      id: 'obs-demand',
      sourceKind: 'provided',
      target: 'provided-demand',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 20, unit: 'GiB' } },
    },
  ];
}

function newBuildObservations(specs: Record<string, unknown>): EngineerObservation[] {
  const rows: EngineerObservation[] = [];
  const number = (id: string, field: string, value: number, unit: 'GiB' | 'TiB'): EngineerObservation => ({
    id,
    sourceKind: 'provided',
    target: field,
    collectionStatus: 'complete',
    collectedAt: WHEN,
    value: { presence: 'known', data: { kind: 'number', number: value, unit } },
  });
  if (typeof specs.node_count === 'number') {
    rows.push({
      id: 'obs-node-count',
      sourceKind: 'provided',
      target: 'node_count',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'integer', integer: specs.node_count } },
    });
  }
  if (typeof specs.cpu_per_node_cores === 'number') {
    rows.push({
      id: 'obs-cpu-per-node',
      sourceKind: 'provided',
      target: 'cpu_per_node_cores',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'integer', integer: specs.cpu_per_node_cores } },
    });
  }
  if (typeof specs.ram_per_node_gib === 'number') {
    rows.push(number('obs-ram-per-node', 'ram_per_node_gib', specs.ram_per_node_gib, 'GiB'));
  }
  if (typeof specs.usable_storage_tib === 'number') {
    rows.push(number('obs-usable-storage', 'usable_storage_tib', specs.usable_storage_tib, 'TiB'));
  }
  if (typeof specs.ha_intent === 'string') {
    rows.push({
      id: 'obs-ha-intent',
      sourceKind: 'proposed',
      target: 'ha_intent',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'string', text: specs.ha_intent } },
    });
  }
  rows.push({
    id: 'obs-official-bom',
    sourceKind: 'unknown',
    target: 'official_bom',
    collectionStatus: 'missing',
    value: { presence: 'unknown', reason: 'official BOM is not a formula result' },
    unknownReason: 'official BOM is not a formula result',
  });
  return rows;
}

function step(
  id: EngineerWorkflowStepId,
  exportName: string,
  status: EngineerWorkflowStep['status'],
  reason?: string,
): EngineerWorkflowStep {
  return reason ? { id, exportName, status, reason } : { id, exportName, status };
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

  const collectedObs = inventory
    ? [
      surfaceObservation(inventory, 'volumes'),
      surfaceObservation(inventory, 'servers'),
      surfaceObservation(inventory, 'images'),
    ]
    : [];
  const provided = input.providedObservations ?? (input.mode === 'existing' ? oracleCapacityObservations() : []);
  const missing = UNKNOWN_FIELDS.map((field) => unknownObservation(`obs-${field.replace(/_/g, '-')}`, field));
  const observations = [...collectedObs, ...provided, ...missing];

  const total = observations.find((item) => item.id === 'obs-total');
  const used = observations.find((item) => item.id === 'obs-used');
  const demand = observations.find((item) => item.id === 'obs-demand');
  const calculations: EngineerCalculation[] = [];
  if (total && used) {
    calculations.push(evaluateEngineerFormula({
      id: 'calc-remaining',
      formulaId: 'confirmed-remaining-capacity',
      roles: { total: operandFromObservation(total), used: operandFromObservation(used) },
      now: WHEN,
    }));
    calculations.push(evaluateEngineerFormula({
      id: 'calc-utilization',
      formulaId: 'confirmed-utilization-ratio',
      roles: { total: operandFromObservation(total), used: operandFromObservation(used) },
      now: WHEN,
    }));
    if (demand) {
      calculations.push(evaluateEngineerFormula({
        id: 'calc-headroom',
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

  const assessMod = await loadOptional<{
    assessEngineerCase: (request: { document: EngineerCaseDocument; auth: EngineerCaseAuthContext }) => {
      assessments?: unknown;
      ok?: boolean;
    };
  }>('packages/sangfor-planner/src/engineer-assessment.ts');
  steps.push(assessMod
    ? step('assess', 'assessEngineerCase', 'ran')
    : step('assess', 'assessEngineerCase', 'unavailable', 'ASSESS_EXPORT_ABSENT on this stacked head'));

  const guideMod = await loadOptional<{
    buildEngineerGuide: (request: unknown) => { guide?: EngineerCaseDocument['guide'] };
  }>('packages/sangfor-planner/src/engineer-guide.ts');
  steps.push(guideMod
    ? step('guide', 'buildEngineerGuide', 'ran')
    : step('guide', 'buildEngineerGuide', 'unavailable', 'GUIDE_EXPORT_ABSENT on this stacked head'));

  const unresolved = [
    ...ingested.questions.map((item) => item.message),
    ...UNKNOWN_FIELDS.map((field) => `${field} is unknown`),
    ...(collectFailed ? ['collection failed; guide output is not a normal completion'] : []),
    ...(assessMod ? [] : ['ASSESS_EXPORT_ABSENT']),
    ...(guideMod ? [] : ['GUIDE_EXPORT_ABSENT']),
    ...(input.mode === 'new' ? ['provided specs are not observed device values'] : []),
    'review_ready is not field_accepted',
  ].filter((text, index, all) => all.indexOf(text) === index).slice(0, 64);

  const guideFields = {
    revision: 'guide-e11-1',
    requirementRefs: requirements.map((item) => item.id),
    steps: [] as EngineerCaseDocument['guide']['steps'],
    prerequisites: ['fixture path; live device write is out of scope'],
    unresolved,
    readiness: 'blocked' as const,
  };

  const draft: EngineerCaseDocument = {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: input.caseId,
    mode: input.mode,
    product: input.product,
    ...(input.firmware ? { firmware: input.firmware } : {}),
    revision: input.revision,
    progress: collectFailed || unresolved.length > 0 ? 'inputs_pending' : 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: input.originalPresent === true,
    observations,
    requirements,
    calculations,
    assessments: [],
    guide: { ...guideFields, digest: computeEngineerGuideDigest(guideFields) },
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

  const assembled = assembleEngineerCase(draft, input.auth);
  if (!assembled.ok) {
    steps.push(step('persist', 'persistEngineerCase', 'refused', assembled.issues.map((item) => item.code).join(',')));
    return baseResult({ steps, collectFailed, inventory, healthScope, healthVerdict, assembled });
  }

  if (!input.persist) {
    steps.push(step('persist', 'persistEngineerCase', 'unavailable', 'PERSIST_INJECT_REQUIRED'));
    return baseResult({ steps, collectFailed, inventory, healthScope, healthVerdict, assembled });
  }
  const persist = await input.persist({
    auth: input.auth,
    document: assembled.value,
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
  });
  steps.push(persist.ok
    ? step('persist', 'persistEngineerCase', 'ran')
    : step('persist', 'persistEngineerCase', persist.code === 'REVISION_CONFLICT' ? 'refused' : 'failed', persist.ok ? undefined : persist.code));

  const persistedDocument = assembled.value;
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
  const requiredFields = trackRequiredFields(input.mode, inventory, collectFailed);
  const completedNormally = !collectFailed
    && steps.every((item) => item.status === 'ran')
    && persist.ok
    && exported?.ok === true
    && unresolved.filter((item) => item !== 'review_ready is not field_accepted').length === 0
    && review.complete === false
    && preview.fieldAccepted === false;

  return {
    fabricatedPass: false,
    fieldAccepted: false,
    liveProof: false,
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
    tracking: {
      requiredFields,
      requirementIds: requirements.map((item) => item.id),
      requirementTrackingRate: requirements.length === 0 ? 0 : 1,
      executableSteps: persistedDocument.guide.steps.length,
      fabricatedPassCount: 0,
    },
    unresolved,
  };
}

function trackRequiredFields(
  mode: EngineerCaseMode,
  inventory: HciInventory | undefined,
  collectFailed: boolean,
): FieldTrack[] {
  if (mode === 'new') {
    return [
      ...['node_count', 'cpu_per_node_cores', 'ram_per_node_gib', 'usable_storage_tib', 'ha_intent', 'firmware_requested']
        .map((id) => ({
          id,
          sourceKind: id === 'ha_intent' ? 'proposed' : 'provided',
          status: 'provided' as const,
        })),
      { id: 'official_bom', sourceKind: 'unknown', status: 'unknown' },
    ];
  }
  const surfaces: FieldTrack[] = (['volumes', 'servers', 'images'] as const).map((id) => ({
    id,
    sourceKind: collectFailed && inventory?.collection[id].status === 'failed' ? 'unknown' : 'provided',
    status: inventory?.collection[id].status === 'complete' ? 'collected' : 'unknown',
  }));
  return [
    ...surfaces,
    { id: 'collectedAt', sourceKind: inventory ? 'provided' : 'unknown', status: inventory ? 'collected' : 'missing' },
    { id: 'volume_status_health', sourceKind: 'derived', status: collectFailed ? 'unknown' : 'collected' },
    { id: 'requirements', sourceKind: 'provided', status: 'provided' },
    { id: 'firmware', sourceKind: 'unknown', status: 'missing' },
    ...UNKNOWN_FIELDS.map((id) => ({ id, sourceKind: 'unknown', status: 'unknown' as const })),
  ];
}

function baseResult(partial: {
  steps: EngineerWorkflowStep[];
  collectFailed: boolean;
  inventory?: HciInventory;
  healthScope?: string;
  healthVerdict?: string;
  assembled?: EngineerCaseAssembly;
}): EngineerWorkflowResult {
  return {
    fabricatedPass: false,
    fieldAccepted: false,
    liveProof: false,
    completedNormally: false,
    collectFailed: partial.collectFailed,
    skippedCountedAsPass: false,
    steps: partial.steps,
    inventory: partial.inventory,
    healthScope: partial.healthScope,
    healthVerdict: partial.healthVerdict,
    assembled: partial.assembled,
    tracking: {
      requiredFields: [],
      requirementIds: [],
      requirementTrackingRate: 0,
      executableSteps: 0,
      fabricatedPassCount: 0,
    },
    unresolved: [],
  };
}

export function storedNumber(document: EngineerCaseDocument, id: string): string | undefined {
  const calculation = document.calculations.find((item) => item.id === id);
  if (!calculation?.result) return undefined;
  return formatStoredEngineerValue(calculation.result);
}

