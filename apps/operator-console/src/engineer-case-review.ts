import { unsavedEngineerCase } from '../../../packages/sangfor-authority/src/engineer-case-persistence.js';
import type { EngineerCaseUnsaved } from '../../../packages/sangfor-authority/src/authority-store-contracts.js';
import {
  parseEngineerCaseDocument,
  type EngineerAssessment,
  type EngineerCalculation,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerObservation,
  type EngineerRequirement,
  type EngineerValue,
} from '../../../packages/shared/src/engineer-case-contract.js';
import { assembleEngineerCaseDraft, type EngineerCaseDraft } from './engineer-case-draft.js';
import {
  engineerCaseHttpStatus,
  type EngineerCaseApiPort,
} from './engineer-case-api.js';
import { projectEngineerGuidePreview, type EngineerGuidePreview } from './engineer-case-guide-preview.js';

export type EngineerCaseReviewBody = {
  readonly caseId?: string;
  readonly draft?: EngineerCaseDraft;
};

export type EngineerCaseReviewRow = {
  readonly id: string;
  readonly title: string;
  readonly sourceKindLabel: string;
  readonly detail: string;
  readonly nextAction?: string;
};

export type EngineerCaseReviewView = {
  readonly caseId: string;
  readonly revision: string;
  readonly modeLabel: string;
  readonly product: string;
  readonly firmwareLabel: string;
  readonly progressClaim: string;
  readonly collectionConnected: false;
  readonly collectionSummary: string;
  readonly complete: false;
  readonly requirements: readonly EngineerCaseReviewRow[];
  readonly observations: readonly EngineerCaseReviewRow[];
  readonly calculations: readonly EngineerCaseReviewRow[];
  readonly unresolved: readonly EngineerCaseReviewRow[];
  readonly nextActions: readonly string[];
  readonly failures: readonly string[];
  readonly guide: EngineerGuidePreview;
};

export type EngineerCaseReviewSuccess = {
  readonly ok: true;
  readonly status: 'reviewed';
  readonly durable: 'saved' | 'unsaved';
  readonly approved: false;
  readonly resumable: boolean;
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
  readonly collectionConnected: false;
  readonly saveComplete: false;
  readonly review: EngineerCaseReviewView;
  readonly document: EngineerCaseDocument;
};

export type EngineerCaseReviewFailure = EngineerCaseUnsaved & {
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
  readonly collectionConnected: false;
  readonly saveComplete: false;
};

const SOURCE_LABEL: Record<string, string> = {
  observed: '관측값',
  provided: '제공값',
  derived: '계산값',
  proposed: '제안값',
  unknown: '미확인',
};

const NEXT_LABEL: Record<string, string> = {
  add_information: '정보 추가',
  recollect: '다시 수집',
  design_decision: '설계 결정',
  config_change: '설정 변경',
  none: '후속 없음',
};

function formatValue(value: EngineerValue | undefined): string {
  if (!value) return '미확인';
  if (value.presence === 'unknown') return `미확인 (${value.reason})`;
  const data = value.data;
  if (data.kind === 'number') return `${data.number} ${data.unit}`;
  if (data.kind === 'integer') return `${data.integer}${data.unit ? ` ${data.unit}` : ''}`;
  if (data.kind === 'boolean') return data.boolean ? '예' : '아니오';
  return data.text;
}

function requirementDetail(item: EngineerRequirement): string {
  return `${item.constraint ?? item.acceptanceCriterion} · 확인=${item.confirmationState} · 우선=${item.priority}`;
}

function observationDetail(item: EngineerObservation): string {
  return `${item.target ?? item.id}: ${formatValue(item.value)} · 수집=${item.collectionStatus}`;
}

function calculationDetail(item: EngineerCalculation): string {
  if (item.unavailableReason || item.sourceKind === 'unknown' || item.result?.presence === 'unknown') {
    return `계산 불가 (${item.unavailableReason ?? (item.result?.presence === 'unknown' ? item.result.reason : '결과 없음')})`;
  }
  return `${item.formulaId}@${item.formulaVersion}: ${formatValue(item.result)}`;
}

function assessmentRow(item: EngineerAssessment): EngineerCaseReviewRow {
  return {
    id: item.id,
    title: item.requirementRef,
    sourceKindLabel: item.status === 'unresolved' ? '미확인' : `판정 ${item.status}`,
    detail: item.reasons.join('; '),
    nextAction: NEXT_LABEL[item.nextAction] ?? item.nextAction,
  };
}

export function projectEngineerCaseReview(
  document: EngineerCaseDocument,
  durable: 'saved' | 'unsaved' = 'unsaved',
): EngineerCaseReviewView {
  const calcUnavailable = document.calculations.length === 0
    || document.calculations.some((item) => item.sourceKind === 'unknown' || item.result?.presence === 'unknown' || !!item.unavailableReason);
  const failures = [
    '장비 수집이 연결되어 있지 않습니다',
    ...(calcUnavailable ? ['계산 불가'] : []),
    ...(document.execution.result === 'indeterminate' ? ['실행 결과는 미확정이며 통과가 아닙니다'] : []),
  ];
  const unresolved = [
    ...document.guide.unresolved.map((text, index) => ({
      id: `unresolved-${index + 1}`,
      title: text,
      sourceKindLabel: '미확인',
      detail: text,
    })),
    ...document.assessments.filter((item) => item.status === 'unresolved').map(assessmentRow),
  ];
  return {
    caseId: document.caseId,
    revision: document.revision,
    modeLabel: document.mode === 'new' ? '신규 구축' : '기존 환경',
    product: document.product,
    firmwareLabel: document.firmware ?? '미확인',
    progressClaim: `문서 진행 ${document.progress} (승인·현장 인수 아님)`,
    collectionConnected: false,
    collectionSummary: '이 화면은 장비 수집에 연결되어 있지 않습니다. 입력값은 제공값 또는 미확인입니다.',
    complete: false,
    requirements: document.requirements.map((item) => ({
      id: item.id,
      title: item.constraint ?? item.acceptanceCriterion,
      sourceKindLabel: SOURCE_LABEL[item.sourceKind] ?? '미확인',
      detail: requirementDetail(item),
    })),
    observations: document.observations.map((item) => ({
      id: item.id,
      title: item.target ?? item.id,
      sourceKindLabel: SOURCE_LABEL[item.sourceKind] ?? '미확인',
      detail: observationDetail(item),
    })),
    calculations: document.calculations.length === 0
      ? [{ id: 'calc-none', title: '계산 없음', sourceKindLabel: '미확인', detail: '계산 불가 — 이 화면은 계산을 다시 수행하지 않습니다' }]
      : document.calculations.map((item) => ({
        id: item.id,
        title: item.formulaId,
        sourceKindLabel: SOURCE_LABEL[item.sourceKind] ?? '미확인',
        detail: calculationDetail(item),
      })),
    unresolved,
    nextActions: [
      ...new Set([
        ...document.assessments.map((item) => NEXT_LABEL[item.nextAction] ?? item.nextAction),
        ...(calcUnavailable ? ['정보 추가'] : []),
        '장비 수집 연결 후 관측값으로 승격하지 말고 다시 검토',
      ]),
    ],
    failures,
    guide: projectEngineerGuidePreview(document, durable),
  };
}

function reviewUnsaved(code: EngineerCaseUnsaved['code'], issues?: EngineerCaseUnsaved['issues']): EngineerCaseReviewFailure {
  return {
    ...unsavedEngineerCase(code, issues),
    guideReadyGranted: false,
    executionPassGranted: false,
    collectionConnected: false,
    saveComplete: false,
  };
}

function reviewOk(document: EngineerCaseDocument, durable: 'saved' | 'unsaved', resumable: boolean): EngineerCaseReviewSuccess {
  return {
    ok: true,
    status: 'reviewed',
    durable,
    approved: false,
    resumable,
    guideReadyGranted: false,
    executionPassGranted: false,
    collectionConnected: false,
    saveComplete: false,
    review: projectEngineerCaseReview(document, durable),
    document,
  };
}

export async function postReviewEngineerCase(
  body: EngineerCaseReviewBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
): Promise<{ readonly status: number; readonly body: EngineerCaseReviewSuccess | EngineerCaseReviewFailure }> {
  if (!auth) return { status: 401, body: reviewUnsaved('SCOPE_UNAUTHORIZED') };
  if (body.caseId && !body.draft) {
    const loaded = await store.load({ ...auth, caseId: body.caseId });
    if (!loaded.ok) return { status: engineerCaseHttpStatus(loaded), body: reviewUnsaved(loaded.code, loaded.issues) };
    try {
      return { status: 200, body: reviewOk(parseEngineerCaseDocument(JSON.stringify(loaded.document)), 'saved', true) };
    } catch {
      return { status: 400, body: reviewUnsaved('VALIDATION_FAILED') };
    }
  }
  if (!body.draft) return { status: 400, body: reviewUnsaved('VALIDATION_FAILED') };
  const assembled = assembleEngineerCaseDraft(body.draft, auth);
  if (!assembled.ok) {
    return {
      status: 400,
      body: reviewUnsaved('VALIDATION_FAILED', assembled.issues.map((issue) => ({ code: issue.code, path: issue.path }))),
    };
  }
  return { status: 200, body: reviewOk(assembled.value, 'unsaved', false) };
}
