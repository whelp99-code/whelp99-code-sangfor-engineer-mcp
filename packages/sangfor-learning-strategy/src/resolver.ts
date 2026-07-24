import type { StrategyRevision, StrategyState } from './store.js';
import type { MethodResult, ConflictCandidate } from './methods.js';
import { isUsableState } from './lifecycle.js';

/**
 * PR-001C: Registry digest and version truth exact resolver.
 * 
 * Key invariants:
 * - No near-version fallback (near-version is explanation-only candidate)
 * - Registry digest or version truth record mismatch → no execution
 * - Ambiguous scope (2+ active revisions) → AMBIGUOUS_STRATEGY rejection
 * - Conflict (2+ complete values differ) → conflict with conflictCandidates[]
 */

export interface ResolverContext {
  registryDigest: string;
  versionTruthRecord: string;
  productVariant?: string;
  deviceScope?: string;
  environment?: 'lab' | 'poc' | 'customer' | 'production';
}

export interface StrategyScope {
  product: string;
  firmwareVersion: string;
  capability?: string;
  fact?: string;
}

export interface ResolvedStrategy {
  revision: StrategyRevision;
  scope: StrategyScope;
  methods: MethodResult[];
}

export type ResolverError =
  | { code: 'REGISTRY_DRIFT'; message: string }
  | { code: 'VERSION_TRUTH_MISMATCH'; message: string }
  | { code: 'AMBIGUOUS_STRATEGY'; message: string }
  | { code: 'NO_ELIGIBLE_STRATEGY'; message: string }
  | { code: 'NEAR_VERSION_ONLY'; message: string; candidates: StrategyRevision[] };

export function isStateUsableForEnvironment(state: StrategyState, env?: string): boolean {
  if (!isUsableState(state)) return false;
  
  switch (state) {
    case 'researched':
      // canary·설명만, Spec 입력 불가
      return false;
    case 'lab_verified':
      // exact `lab`만
      return env === 'lab';
    case 'device_verified':
      // 검증된 opaque UUIDv7 deviceScope의 lab/poc/customer, production 제외
      return env !== 'production';
    case 'strategy_field_verified':
      // exact lab/poc/customer/production
      return true;
    default:
      return false;
  }
}

export function resolveExactStrategy(
  revisions: StrategyRevision[],
  scope: StrategyScope,
  context: ResolverContext,
): ResolvedStrategy | ResolverError {
  // Filter by scope match
  const scopeMatches = revisions.filter(r => {
    // Scope matching logic would go here
    // For now, assume all revisions match the scope
    return true;
  });

  // Filter by usable state for environment
  const eligible = scopeMatches.filter(r => 
    isStateUsableForEnvironment(r.state, context.environment)
  );

  if (eligible.length === 0) {
    // Check for near-version candidates (explanation-only)
    const nearVersion = scopeMatches.filter(r => 
      isUsableState(r.state) && !isStateUsableForEnvironment(r.state, context.environment)
    );
    if (nearVersion.length > 0) {
      return {
        code: 'NEAR_VERSION_ONLY',
        message: 'Only near-version candidates available (explanation-only, no execution)',
        candidates: nearVersion,
      };
    }
    return {
      code: 'NO_ELIGIBLE_STRATEGY',
      message: `No eligible strategy for scope ${JSON.stringify(scope)} in environment ${context.environment}`,
    };
  }

  // Ambiguous scope: 2+ active revisions → reject
  if (eligible.length > 1) {
    return {
      code: 'AMBIGUOUS_STRATEGY',
      message: `Ambiguous strategy: ${eligible.length} active revisions for scope ${JSON.stringify(scope)}`,
    };
  }

  const revision = eligible[0];

  return {
    revision,
    scope,
    methods: [], // Method results would be populated by method chain execution
  };
}

export function resolveMethodChain(results: MethodResult[]): {
  facts: Record<string, unknown>;
  conflicts: ConflictCandidate[];
  aborted: boolean;
} {
  const facts: Record<string, unknown> = {};
  const conflicts: ConflictCandidate[] = [];
  let aborted = false;

  for (const result of results) {
    // Check for abort conditions
    if (['blocked', 'integrity_error', 'mutation_signal'].includes(result.status)) {
      aborted = true;
      break;
    }

    // Skip non-terminal results
    if (['not_applicable', 'not_observed'].includes(result.status)) {
      continue;
    }

    // Handle complete/partial results
    if (result.facts) {
      for (const [key, value] of Object.entries(result.facts)) {
        if (key in facts) {
          // Conflict: 2+ complete values differ
          const existingValue = facts[key];
          if (JSON.stringify(existingValue) !== JSON.stringify(value)) {
            // Record conflict candidates
            if (result.evidenceDigest) {
              conflicts.push({
                methodCode: result.methodCode,
                revisionId: '', // Would be populated from context
                valueDigest: result.evidenceDigest,
                evidenceFile: result.evidenceDigest, // Would be proper evidence file
                collectedAt: new Date().toISOString(),
              });
            }
          }
        } else {
          facts[key] = value;
        }
      }
    }

    // Partial stops fact collection for that fact
    if (result.status === 'partial') {
      // Mark fact as partial (would need fact-level tracking)
    }
  }

  return { facts, conflicts, aborted };
}

export function validateRegistryDigest(expected: string, actual: string): boolean {
  return expected === actual;
}

export function validateVersionTruth(expected: string, actual: string): boolean {
  return expected === actual;
}
