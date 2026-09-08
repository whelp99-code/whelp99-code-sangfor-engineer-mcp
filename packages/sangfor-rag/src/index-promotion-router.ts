import { z } from 'zod';
import { evaluateIndexPromotion, IndexPromotionReportError, parseIndexPromotionReport } from './index-promotion-evaluator.js';
import type {
  PromotionSearchOptions,
  PromotionSearchPort,
  PromotionSearchResult,
} from './index-promotion-types.js';
import { PgvectorHitRowSchema, type PgvectorSearch } from './pgvector-types.js';

export class CandidateSearchUnavailableError extends Error {
  readonly name = 'CandidateSearchUnavailableError';
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}

export class IndexPromotionRouter {
  constructor(private readonly port: PromotionSearchPort) {}

  async search(input: PgvectorSearch, options: PromotionSearchOptions): Promise<PromotionSearchResult> {
    if (options.backend === 'exact') return this.exact(input, 'EXACT_REQUESTED');
    const rawReport = await this.port.loadPromotion(input.scope);
    if (rawReport === null) return this.exact(input, 'PROMOTION_NOT_FOUND');
    let reportResult;
    try {
      reportResult = parseIndexPromotionReport(rawReport);
    } catch (error) {
      if (error instanceof IndexPromotionReportError) return this.exact(input, error.code);
      throw error;
    }
    const expectedIdentity = await this.port.preflightCandidate(input.scope, reportResult.indexName);
    if (!expectedIdentity) return this.exact(input, 'CANDIDATE_PREFLIGHT_UNAVAILABLE');
    const current = await this.port.readCurrentState(input.scope);
    const evaluation = evaluateIndexPromotion(reportResult, current, options.now);
    if (!evaluation.eligible) return this.exact(input, evaluation.reason);
    await options.beforeCandidateDispatch?.();
    try {
      const hits = z.array(PgvectorHitRowSchema).parse(await this.port.searchCandidate(input, expectedIdentity));
      return { backend: 'hnsw', hits, diagnostics: { reason: 'PROMOTION_VALID', reportDigest: reportResult.reportDigest } };
    } catch (error) {
      throw new CandidateSearchUnavailableError('RAG_HNSW_CANDIDATE_UNAVAILABLE', { cause: error });
    }
  }

  private async exact(input: PgvectorSearch, reason: string): Promise<PromotionSearchResult> {
    const hits = z.array(PgvectorHitRowSchema).parse(await this.port.searchExact(input));
    return { backend: 'exact', hits, diagnostics: { reason } };
  }
}
