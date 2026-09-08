import {
  resolveProductionLocalWriteAuthority,
  resolveRepoData,
  type LocalWriteAuthority,
} from '@sangfor/shared';
import { assertSafeLearningInput } from './input-guard.js';
import { resolveExactStrategy, type ResolverContext, type StrategyScope } from './resolver.js';
import type {
  LearningFactCollection,
  LearningFactQueryRequest,
  PromoteStrategyRequest,
  ResearchStrategyRequest,
  StrategyListPage,
  StrategyListRequest,
  StrategyPromotion,
  StrategyResearchResult,
  StrategyValidation,
  ValidateStrategyRequest,
} from './service-contracts.js';
import { researchStrategy } from './strategy-authoring.js';
import { assertFactQueryRequest, collectStrategyFacts } from './strategy-facts.js';
import { listStrategyRevisions } from './strategy-listing.js';
import { allStrategyRevisions, type StrategyStoreAccess } from './strategy-store-access.js';
import { promoteStrategyRevision, toValidationRequest, validateStrategyRevision } from './strategy-transition.js';

export * from './service-contracts.js';
export { assertSafeLearningInput } from './input-guard.js';

/**
 * The public facade over the learning strategy operations: it owns the untrusted
 * boundary and the store root, and delegates each operation to its module.
 */
export class LearningStrategyService {
  private readonly authority: LocalWriteAuthority;

  constructor(private readonly root = resolveRepoData('data/runtime/learning-strategies'), authority?: LocalWriteAuthority) {
    this.authority = resolveProductionLocalWriteAuthority({
      tenantId: 'local-primary',
      projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary',
      actorId: 'local-primary',
      aggregate: 'learning_strategy_lifecycle',
      sourceRoot: this.root,
    }, authority);
  }

  private storeAccess(): StrategyStoreAccess {
    return { root: this.root, authority: this.authority };
  }

  list(request: StrategyListRequest = {}): StrategyListPage {
    assertSafeLearningInput(request, ['strategyId', 'vendor', 'product', 'firmwareVersion', 'status', 'cursor', 'limit']);
    return listStrategyRevisions(this.storeAccess(), request);
  }

  resolve(scope: StrategyScope, context: ResolverContext): ReturnType<typeof resolveExactStrategy> {
    assertSafeLearningInput(scope, ['product', 'firmwareVersion', 'capability', 'fact']);
    assertSafeLearningInput(context, ['registryDigest', 'versionTruthRecord', 'productVariant', 'deviceScope', 'environment']);
    return resolveExactStrategy(allStrategyRevisions(this.storeAccess()), scope, context);
  }

  async research(request: ResearchStrategyRequest): Promise<StrategyResearchResult> {
    assertSafeLearningInput(request, ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'productVariant', 'officialCitation', 'pageVerified', 'captureEvidenceFile', 'methods']);
    return researchStrategy(this.storeAccess(), request);
  }

  validate(request: ValidateStrategyRequest): StrategyValidation {
    assertSafeLearningInput(request, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest']);
    return validateStrategyRevision(this.storeAccess(), request);
  }

  async promote(request: PromoteStrategyRequest): Promise<StrategyPromotion> {
    assertSafeLearningInput(request, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest', 'toState', 'approvalPayload', 'approvalToken', 'evidenceRoot']);
    const access = this.storeAccess();
    const validation = validateStrategyRevision(access, toValidationRequest(request));
    return promoteStrategyRevision(access, request, validation);
  }

  collectFacts(request: LearningFactQueryRequest): LearningFactCollection {
    assertSafeLearningInput(request, ['scope', 'context', 'factIds', 'methodResults', 'allowCanary']);
    assertFactQueryRequest(request);
    return collectStrategyFacts(request, this.resolve(request.scope, request.context));
  }
}
