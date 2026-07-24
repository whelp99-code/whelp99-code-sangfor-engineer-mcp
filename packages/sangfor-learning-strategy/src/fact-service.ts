import type { StrategyRevision } from './store.js';
import type { MethodResult, ConflictCandidate } from './methods.js';
import { resolveMethodChain, type ResolverContext, type StrategyScope } from './resolver.js';

/**
 * PR-002: Fact query service.
 * 
 * Queries strategy revisions and executes method chains to produce fact results.
 */

export interface FactQuery {
  scope: StrategyScope;
  factIds: string[];
  context: ResolverContext;
}

export interface FactQueryResult {
  factId: string;
  status: 'complete' | 'partial' | 'not_observed' | 'not_applicable' | 'conflict';
  value?: unknown;
  methodCode?: string;
  revisionId?: string;
  evidenceFile?: string;
  evidenceDigest?: string;
  conflictCandidates?: ConflictCandidate[];
}

export interface FactServiceOptions {
  revisions: StrategyRevision[];
  methodResults?: MethodResult[];
}

export class FactService {
  constructor(private readonly options: FactServiceOptions) {}

  query(query: FactQuery): FactQueryResult[] {
    const results: FactQueryResult[] = [];

    for (const factId of query.factIds) {
      const result = this.queryFact(factId, query);
      results.push(result);
    }

    return results;
  }

  private queryFact(factId: string, query: FactQuery): FactQueryResult {
    // Find revisions matching the scope
    const matchingRevisions = this.options.revisions.filter(r => {
      // Scope matching logic
      return true; // Simplified for now
    });

    if (matchingRevisions.length === 0) {
      return {
        factId,
        status: 'not_observed',
      };
    }

    // Execute method chain
    const methodResults = this.options.methodResults ?? [];
    const { facts, conflicts, aborted } = resolveMethodChain(methodResults);

    if (aborted) {
      return {
        factId,
        status: 'not_applicable',
      };
    }

    if (conflicts.length > 0) {
      return {
        factId,
        status: 'conflict',
        conflictCandidates: conflicts,
      };
    }

    if (factId in facts) {
      return {
        factId,
        status: 'complete',
        value: facts[factId],
        revisionId: matchingRevisions[0]?.revisionId,
      };
    }

    return {
      factId,
      status: 'not_observed',
    };
  }

  isEligibleForResult(result: FactQueryResult): boolean {
    // Only complete results are eligible for Spec conversion
    return result.status === 'complete';
  }

  filterEligibleResults(results: FactQueryResult[]): FactQueryResult[] {
    return results.filter(r => this.isEligibleForResult(r));
  }
}
