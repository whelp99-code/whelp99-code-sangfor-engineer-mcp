// 리비전 수명주기 규칙: 어떤 리비전이 활성인지, 다음 번호가 무엇인지, 심사 판정이 온전한지.

import type { PlaybookRevision } from './playbook-types.js';
import { PlaybookValidationError } from './playbook-validation.js';

// api 계층이 그대로 넘기는 심사 요청. 반려 사유는 여기서만 선택적이다.
export interface ReviewVerdictInput {
  readonly approve: boolean;
  readonly reviewedBy: string;
  readonly rejectReason?: string;
}

// 반려 판정은 사유를 타입으로 증명한다 — 승인 분기에는 사유 필드가 존재하지 않는다.
export type ReviewDecision =
  | { readonly approve: true; readonly reviewedBy: string }
  | { readonly approve: false; readonly reviewedBy: string; readonly rejectReason: string };

// 경계에서 한 번만 파싱한다. reviewedBy는 공백 검사만 하고 원문 그대로 기록한다.
export function parseReviewVerdict(input: ReviewVerdictInput): ReviewDecision {
  if (!input.reviewedBy?.trim()) throw new PlaybookValidationError('reviewedBy는 필수입니다');
  if (input.approve) return { approve: true, reviewedBy: input.reviewedBy };
  const rejectReason = input.rejectReason?.trim();
  if (!rejectReason) throw new PlaybookValidationError('반려 사유(rejectReason)는 필수입니다');
  return { approve: false, reviewedBy: input.reviewedBy, rejectReason };
}

export function nextRevisionNumber(revisions: readonly PlaybookRevision[]): number {
  return Math.max(...revisions.map((r) => r.rev)) + 1;
}

export function activeApprovedRevision(revisions: readonly PlaybookRevision[]): PlaybookRevision | undefined {
  return revisions.filter((r) => r.status === 'approved').sort((a, b) => b.rev - a.rev)[0];
}
