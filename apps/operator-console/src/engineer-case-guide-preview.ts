import type { EngineerCaseDocument } from '../../../packages/shared/src/engineer-case-contract.js';

export type EngineerGuidePreview = {
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly digest: string;
  readonly readinessClaim: string;
  readonly durableLabel: string;
  readonly draftMarked: boolean;
  readonly fieldAccepted: false;
  readonly approvedForWindow: false;
  readonly steps: readonly { readonly id: string; readonly order: number; readonly title: string; readonly verify: string }[];
  readonly unresolved: readonly string[];
  readonly prerequisites: readonly string[];
};

export function projectEngineerGuidePreview(
  document: EngineerCaseDocument,
  durable: 'saved' | 'unsaved',
): EngineerGuidePreview {
  return {
    caseRevision: document.revision,
    guideRevision: document.guide.revision,
    digest: document.guide.digest,
    readinessClaim: `문서 주장 ${document.guide.readiness} (승인·field_accepted·approved_for_window 아님)`,
    durableLabel: durable === 'saved' ? '저장된 현재 revision' : '미저장 초안',
    draftMarked: document.guide.readiness !== 'review_ready',
    fieldAccepted: false,
    approvedForWindow: false,
    steps: document.guide.steps.map((step) => ({
      id: step.id,
      order: step.order,
      title: step.title,
      verify: step.verify,
    })),
    unresolved: [...document.guide.unresolved],
    prerequisites: [...document.guide.prerequisites],
  };
}
