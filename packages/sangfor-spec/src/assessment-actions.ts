/** Structured, read-only follow-up advice for spec assessment outcomes. */

import type { ActionableReason, AssessmentActionCode, AssessmentNextAction, AssessmentReasonCode, ItemResult } from './types.js';

const labels: Record<AssessmentActionCode, string> = {
  SET_FRESHNESS_POLICY: '항목별 관측 유효시간 정책을 담당자가 명시하고 승인합니다.',
  RECOLLECT_OBSERVATION: '대상 항목을 read-only로 다시 수집해 관측 시각과 값을 확인합니다.',
  COMPLETE_COLLECTION: '수집 범위를 완료한 뒤 read-only 결과를 다시 평가합니다.',
  OBSERVE_REQUIRED_VALUE: '누락된 설정값을 read-only로 관측한 뒤 다시 평가합니다.',
  NORMALIZE_OBSERVED_VALUE: '관측값의 타입과 형식을 확인해 스펙 비교에 사용할 수 있는 값으로 정규화합니다.',
  SET_ASSESSMENT_TIME: '평가 기준 시각을 원본 스냅샷과 함께 제공하거나 시계 설정을 확인합니다.',
  REQUEST_SENIOR_REVIEW: '시니어 엔지니어가 근거와 고객 환경을 검토합니다.',
  REVIEW_CONFIRMED_FAIL: '확인된 FAIL을 담당 엔지니어가 검토하고 승인된 절차에 따라 조치 여부를 결정합니다.',
};

const actionsByReason: Record<AssessmentReasonCode, readonly AssessmentActionCode[]> = {
  ASSESSMENT_TIME_MISSING: ['SET_ASSESSMENT_TIME'], ASSESSMENT_TIME_INVALID: ['SET_ASSESSMENT_TIME'],
  FRESHNESS_POLICY_MISSING: ['SET_FRESHNESS_POLICY'], FRESHNESS_POLICY_INVALID: ['SET_FRESHNESS_POLICY'],
  EVIDENCE_EXPIRED: ['RECOLLECT_OBSERVATION'], EVIDENCE_MISSING: ['RECOLLECT_OBSERVATION'], EVIDENCE_FUTURE: ['RECOLLECT_OBSERVATION'],
  COLLECTION_INCOMPLETE: ['COMPLETE_COLLECTION'], COLLECTION_UNPROVEN: ['COMPLETE_COLLECTION'],
  OBSERVED_VALUE_MISSING: ['OBSERVE_REQUIRED_VALUE'], OBSERVED_VALUE_INCOMPATIBLE: ['NORMALIZE_OBSERVED_VALUE'],
  SENIOR_REVIEW_REQUIRED: ['REQUEST_SENIOR_REVIEW'],
  CONFIRMED_FAIL: ['REVIEW_CONFIRMED_FAIL'],
};

export function nextActionsFor(reasonCode: AssessmentReasonCode): AssessmentNextAction[] {
  return actionsByReason[reasonCode].map((code) => ({ code, label: labels[code] }));
}

export function aggregateActionableReasons(items: readonly ItemResult[]): ActionableReason[] {
  const grouped = new Map<AssessmentReasonCode, string[]>();
  for (const item of items) {
    const code = item.actionableReason?.code;
    if (code) grouped.set(code, [...(grouped.get(code) ?? []), item.id]);
  }
  return [...grouped.entries()].map(([code, itemIds]) => ({ code, itemIds }));
}

/** Preserve the item-level action shape while making result actions identify scope. */
export function aggregateNextActions(items: readonly ItemResult[]): AssessmentNextAction[] {
  const grouped = new Map<AssessmentActionCode, { label: string; itemIds: string[] }>();
  for (const item of items) for (const action of item.nextActions ?? []) {
    const current = grouped.get(action.code) ?? { label: action.label, itemIds: [] };
    current.itemIds.push(item.id);
    grouped.set(action.code, current);
  }
  return [...grouped.entries()].map(([code, action]) => ({ code, label: action.label, itemIds: action.itemIds }));
}
