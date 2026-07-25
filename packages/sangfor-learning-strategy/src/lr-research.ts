import { createHash } from 'node:crypto';

/**
 * PR-009: LR-01~LR-04 research, benchmark, stale-candidate workflow.
 * 
 * LR-01: 공식 매뉴얼 citation과 page-verified 후보. 공식 출처의 제품·버전 적용성이 확인되지 않으면 draft 유지.
 * LR-02: passive capture 구조 benchmark와 allowlist 후보. raw secret·payload를 저장하지 않음.
 * LR-03: UI framework·route·store/DOM capability probe. ExtJS/Vue 등 framework를 사전 추정하지 않음.
 * LR-04: 기존 전략 대비 latency·coverage·conflict benchmark. 실제 evidence file 없는 우수성 주장은 승격에 사용하지 않음.
 * 
 * REQ-21: official citation·benchmark·evidence-gap·stale-candidate
 */

export interface LR01Recipe {
  citation: string;
  pageVerified: boolean;
  productApplicability?: string;
  versionApplicability?: string;
}

export interface LR01Result {
  factId: string;
  citation: string;
  pageVerified: boolean;
  productApplicability?: string;
  versionApplicability?: string;
  eligibleForPromotion: boolean;
  collectedAt: string;
}

export type LR01Error =
  | { code: 'MISSING_CITATION'; message: string }
  | { code: 'NOT_PAGE_VERIFIED'; message: string };

export function validateLR01Recipe(recipe: LR01Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.citation || recipe.citation.trim() === '') {
    errors.push('MISSING_CITATION: citation is required');
  }

  if (!recipe.pageVerified) {
    errors.push('NOT_PAGE_VERIFIED: pageVerified must be true for promotion eligibility');
  }

  return { valid: errors.length === 0, errors };
}

export class LR01ResearchFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR01Recipe): Promise<LR01Result | LR01Error> {
    const validation = validateLR01Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'MISSING_CITATION',
        message: validation.errors.join('; '),
      };
    }

    // Eligibility: official source product/version applicability must be confirmed
    const eligibleForPromotion = recipe.pageVerified && 
      !!recipe.productApplicability && 
      !!recipe.versionApplicability;

    return {
      factId: 'lr01-citation',
      citation: recipe.citation,
      pageVerified: recipe.pageVerified,
      productApplicability: recipe.productApplicability,
      versionApplicability: recipe.versionApplicability,
      eligibleForPromotion,
      collectedAt: new Date().toISOString(),
    };
  }
}

export interface LR02Recipe {
  captureStructure: string;
  allowlist: string[];
}

export interface LR02Result {
  factId: string;
  captureStructure: string;
  allowlist: string[];
  benchmarkScore: number;
  collectedAt: string;
}

export type LR02Error =
  | { code: 'RAW_SECRET_DETECTED'; message: string }
  | { code: 'RAW_PAYLOAD_DETECTED'; message: string };

const SECRET_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
];

export function validateLR02Recipe(recipe: LR02Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for raw secrets in capture structure
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(recipe.captureStructure)) {
      errors.push('RAW_SECRET_DETECTED: raw secret pattern found in capture structure');
      break;
    }
  }

  // Check for raw secrets in allowlist
  for (const item of recipe.allowlist) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(item)) {
        errors.push('RAW_SECRET_DETECTED: raw secret pattern found in allowlist');
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export class LR02BenchmarkFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR02Recipe): Promise<LR02Result | LR02Error> {
    const validation = validateLR02Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'RAW_SECRET_DETECTED',
        message: validation.errors.join('; '),
      };
    }

    // Synthetic benchmark score
    const benchmarkScore = 0.85;

    return {
      factId: 'lr02-benchmark',
      captureStructure: recipe.captureStructure,
      allowlist: recipe.allowlist,
      benchmarkScore,
      collectedAt: new Date().toISOString(),
    };
  }
}

export interface LR03Recipe {
  frameworkProbe: string;
  routeProbe: string;
  capabilityProbe: string;
}

export interface LR03Result {
  factId: string;
  detectedFramework?: string;
  routes: string[];
  capabilities: string[];
  collectedAt: string;
}

export type LR03Error =
  | { code: 'FRAMEWORK_ASSUMPTION'; message: string };

export function validateLR03Recipe(recipe: LR03Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // LR-03 should not assume framework beforehand
  const frameworkAssumptions = ['extjs', 'vue', 'react', 'angular'];
  const probeLower = recipe.frameworkProbe.toLowerCase();
  
  for (const assumption of frameworkAssumptions) {
    if (probeLower.includes(assumeFramework(assumption))) {
      errors.push('FRAMEWORK_ASSUMPTION: framework should not be assumed beforehand');
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

function assumeFramework(framework: string): string {
  return framework;
}

export class LR03ProbeFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR03Recipe): Promise<LR03Result | LR03Error> {
    const validation = validateLR03Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'FRAMEWORK_ASSUMPTION',
        message: validation.errors.join('; '),
      };
    }

    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    return {
      factId: 'lr03-probe',
      routes: [],
      capabilities: [],
      collectedAt: new Date().toISOString(),
    };
  }

  private executeSynthetic(recipe: LR03Recipe): LR03Result {
    // Synthetic probe result (no framework assumption)
    return {
      factId: 'lr03-probe',
      detectedFramework: undefined, // No assumption
      routes: ['/dashboard', '/settings', '/license'],
      capabilities: ['read-version', 'read-license', 'read-interfaces'],
      collectedAt: new Date().toISOString(),
    };
  }
}

export interface LR04Recipe {
  baselineStrategyId: string;
  candidateStrategyId: string;
  metrics: ('latency' | 'coverage' | 'conflict')[];
}

export interface LR04Result {
  factId: string;
  baselineStrategyId: string;
  candidateStrategyId: string;
  metrics: Record<string, number>;
  improvement: boolean;
  hasEvidenceFile: boolean;
  collectedAt: string;
}

export type LR04Error =
  | { code: 'MISSING_EVIDENCE'; message: string };

export class LR04BenchmarkFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR04Recipe): Promise<LR04Result | LR04Error> {
    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    // Real benchmark requires evidence file
    return {
      code: 'MISSING_EVIDENCE',
      message: 'Real benchmark requires evidence file for promotion eligibility',
    };
  }

  private executeSynthetic(recipe: LR04Recipe): LR04Result {
    // Synthetic benchmark metrics
    const metrics: Record<string, number> = {};
    for (const metric of recipe.metrics) {
      metrics[metric] = 0.9; // Synthetic improvement score
    }

    const improvement = Object.values(metrics).every(score => score > 0.5);

    return {
      factId: 'lr04-benchmark',
      baselineStrategyId: recipe.baselineStrategyId,
      candidateStrategyId: recipe.candidateStrategyId,
      metrics,
      improvement,
      hasEvidenceFile: false, // Synthetic mode has no real evidence
      collectedAt: new Date().toISOString(),
    };
  }
}

/**
 * Stale candidate workflow.
 * 
 * A stale candidate is a strategy revision that may be outdated but has not been
 * confirmed as stale. It requires human review or verified integrity/mutation
 * safety event to transition to stale state.
 */
export interface StaleCandidate {
  revisionId: string;
  strategyId: string;
  reason: string;
  detectedAt: string;
  confirmed: boolean;
}

export function createStaleCandidate(
  revisionId: string,
  strategyId: string,
  reason: string,
): StaleCandidate {
  return {
    revisionId,
    strategyId,
    reason,
    detectedAt: new Date().toISOString(),
    confirmed: false,
  };
}

export function confirmStaleCandidate(candidate: StaleCandidate): StaleCandidate {
  return {
    ...candidate,
    confirmed: true,
  };
}
