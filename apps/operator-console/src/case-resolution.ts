import { persistFeedbackEvent } from '../../../packages/sangfor-store/src/index.js';
import { proposeWikiUpdate } from '../../../packages/sangfor-wiki/src/index.js';

export interface CaseResolutionInput {
  product: string;
  caseSummary: string;
  resolution: string;
  targetWikiPage: string;
  sourceRole?: string;
}

export async function postCaseResolution(body: CaseResolutionInput) {
  const feedbackId = await persistFeedbackEvent({
    product: body.product,
    feedbackType: 'resolution',
    severity: 'info',
    feedbackText: body.resolution,
    sourceRole: body.sourceRole ?? 'engineer'
  }).catch(() => null);

  const proposal = proposeWikiUpdate({
    lessonTitle: body.caseSummary,
    lessonBody: body.resolution,
    targetPage: body.targetWikiPage
  });

  return { feedbackId, proposalId: proposal.id };
}
