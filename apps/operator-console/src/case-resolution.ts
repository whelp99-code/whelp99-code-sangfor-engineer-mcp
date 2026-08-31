import { persistFeedbackEvent } from '../../../packages/sangfor-store/src/index.js';
import { resolveProductionLocalWriteAuthority, resolveRepoData } from '../../../packages/shared/src/index.js';
import { proposeWikiUpdateWithAuthority } from '../../../packages/sangfor-wiki/src/index.js';

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

  const proposal = await proposeWikiUpdateWithAuthority({
    lessonTitle: body.caseSummary,
    lessonBody: body.resolution,
    targetPage: body.targetWikiPage
  }, resolveProductionLocalWriteAuthority({
    tenantId: 'local-primary', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'operator-console',
    aggregate: 'wiki_proposals', sourceRoot: resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT'),
  }));

  return { feedbackId, proposalId: proposal.id };
}
