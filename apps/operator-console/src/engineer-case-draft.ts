import { assembleEngineerCase, type EngineerCaseAssembly } from '../../../packages/sangfor-planner/src/engineer-case.js';
import {
  computeEngineerGuideDigest,
  ENGINEER_ID_RE,
  ENGINEER_UNITS,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerCaseMode,
  type EngineerCollectionStatus,
  type EngineerObservation,
  type EngineerRequirement,
  type EngineerUnit,
  type EngineerValue,
} from '../../../packages/shared/src/engineer-case-contract.js';
import { PRODUCTS, type ProductCode } from '../../../packages/shared/src/index.js';

export type EngineerCaseCollectionDraft = {
  readonly id?: string;
  readonly label: string;
  readonly valueText?: string;
  readonly unit?: string;
  readonly collectionStatus?: EngineerCollectionStatus;
};

export type EngineerCaseDraft = {
  readonly caseId?: string;
  readonly mode: EngineerCaseMode;
  readonly product: string;
  readonly firmware?: string;
  readonly revision?: string;
  readonly requirementLines: readonly string[];
  readonly collections: readonly EngineerCaseCollectionDraft[];
};

function isId(value: string | undefined): value is string {
  return !!value && ENGINEER_ID_RE.test(value) && value !== '.' && value !== '..' && !value.includes('..');
}

function toId(prefix: string, raw: string, index: number): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const candidate = `${prefix}-${index + 1}-${cleaned || 'item'}`;
  return isId(candidate) ? candidate : `${prefix}-${index + 1}`;
}

function asUnit(text: string | undefined): EngineerUnit | undefined {
  return text && (ENGINEER_UNITS as readonly string[]).includes(text) ? text as EngineerUnit : undefined;
}

function parseValue(valueText: string, unitText?: string): { readonly value: EngineerValue; readonly unknownReason?: string } {
  const trimmed = valueText.trim();
  if (!trimmed) {
    return { value: { presence: 'unknown', reason: '값이 입력되지 않았습니다' }, unknownReason: '값이 입력되지 않았습니다' };
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) {
      return { value: { presence: 'unknown', reason: '유한한 숫자가 아닙니다' }, unknownReason: '유한한 숫자가 아닙니다' };
    }
    const unit = asUnit(unitText);
    if (!unit) {
      const reason = unitText?.trim() ? '단위를 확인할 수 없습니다' : '단위가 없습니다';
      return { value: { presence: 'unknown', reason }, unknownReason: reason };
    }
    return { value: { presence: 'known', data: { kind: 'number', number, unit } } };
  }
  if (unitText?.trim()) {
    return { value: { presence: 'unknown', reason: '문자 값에는 단위를 붙이지 않습니다' }, unknownReason: '문자 값에는 단위를 붙이지 않습니다' };
  }
  return { value: { presence: 'known', data: { kind: 'string', text: trimmed.slice(0, 4096) } } };
}

function productCode(value: string): ProductCode | undefined {
  return PRODUCTS.some((item) => item.code === value) ? value as ProductCode : undefined;
}

export function assembleEngineerCaseDraft(
  draft: EngineerCaseDraft,
  auth: EngineerCaseAuthContext,
): EngineerCaseAssembly {
  const product = productCode(draft.product);
  if (!product) return { ok: false, issues: [{ code: 'VALIDATION_FAILED', path: 'product', message: 'unsupported product' }] };
  const caseId = isId(draft.caseId) ? draft.caseId : `case-${Date.now()}`;
  const revision = isId(draft.revision) ? draft.revision : `rev-${Date.now()}`;
  const requirements: EngineerRequirement[] = draft.requirementLines.map((line, index) => ({
    id: toId('req', line, index),
    sourceKind: 'provided',
    sourceRef: `form-line-${index + 1}`,
    constraint: line.slice(0, 1024),
    priority: 'medium',
    confirmationState: 'unconfirmed',
    acceptanceCriterion: line.slice(0, 1024) || '입력된 요구사항',
    revision: 'reqrev-1',
  }));
  const observations: EngineerObservation[] = draft.collections.map((item, index) => {
    const parsed = parseValue(item.valueText ?? '', item.unit);
    const unknown = parsed.value.presence === 'unknown';
    return {
      id: isId(item.id) ? item.id : toId('obs', item.label, index),
      sourceKind: unknown ? 'unknown' : 'provided',
      value: parsed.value,
      target: item.label.slice(0, 256) || undefined,
      collectionStatus: item.collectionStatus ?? (unknown ? 'missing' : 'complete'),
      ...(unknown ? { unknownReason: parsed.unknownReason } : {}),
    };
  });
  const unresolved = [
    ...requirements.map((item) => `요구사항 ${item.id}는 고객 확인 전입니다`),
    ...observations.filter((item) => item.sourceKind === 'unknown').map((item) => item.unknownReason ?? `관측 ${item.id} 미확인`),
    '계산 결과가 없어 계산을 검토할 수 없습니다',
    '장비 수집이 연결되어 있지 않습니다',
  ].slice(0, 64);
  const document: EngineerCaseDocument = {
    schemaVersion: 'engineer-case.v1',
    caseId,
    mode: draft.mode,
    product,
    ...(draft.firmware?.trim() ? { firmware: draft.firmware.trim().slice(0, 128) } : {}),
    revision,
    progress: observations.some((item) => item.sourceKind === 'unknown') || requirements.length === 0 ? 'inputs_pending' : 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations,
    requirements,
    calculations: [],
    assessments: [],
    guide: {
      revision: 'guide-draft-1',
      digest: '00'.repeat(32),
      requirementRefs: requirements.map((item) => item.id),
      steps: [],
      prerequisites: [],
      unresolved,
      readiness: unresolved.length > 0 ? 'blocked' : 'draft',
    },
    evidence: [],
    execution: { result: 'not_started', reason: 'E10A review does not execute device changes' },
  };
  const guideFields = {
    revision: document.guide.revision,
    requirementRefs: document.guide.requirementRefs,
    steps: document.guide.steps,
    prerequisites: document.guide.prerequisites,
    unresolved: document.guide.unresolved,
    readiness: document.guide.readiness,
  };
  return assembleEngineerCase({
    ...document,
    guide: { ...guideFields, digest: computeEngineerGuideDigest(guideFields) },
  }, auth);
}
