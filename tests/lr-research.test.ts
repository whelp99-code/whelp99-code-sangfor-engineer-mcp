import { describe, it, expect } from 'vitest';
import {
  LR01ResearchFacade,
  LR02BenchmarkFacade,
  LR03ProbeFacade,
  LR04BenchmarkFacade,
  validateLR01Recipe,
  validateLR02Recipe,
  validateLR03Recipe,
  createStaleCandidate,
  confirmStaleCandidate,
  type LR01Recipe,
  type LR02Recipe,
  type LR03Recipe,
  type LR04Recipe,
} from '../packages/sangfor-learning-strategy/src/lr-research.js';

describe('PR-009: LR-01~LR-04 Research', () => {
  describe('validateLR01Recipe', () => {
    it('accepts valid recipe with citation and pageVerified', () => {
      const recipe: LR01Recipe = {
        citation: 'https://docs.sangfor.com/iag/13.0/admin',
        pageVerified: true,
        productApplicability: 'IAG',
        versionApplicability: '13.0.120',
      };
      const result = validateLR01Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe without citation', () => {
      const recipe: LR01Recipe = {
        citation: '',
        pageVerified: true,
      };
      const result = validateLR01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MISSING_CITATION'))).toBe(true);
    });

    it('rejects recipe without pageVerified', () => {
      const recipe: LR01Recipe = {
        citation: 'https://docs.sangfor.com/iag/13.0/admin',
        pageVerified: false,
      };
      const result = validateLR01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('NOT_PAGE_VERIFIED'))).toBe(true);
    });
  });

  describe('LR01ResearchFacade', () => {
    it('executes valid recipe and determines promotion eligibility', async () => {
      const facade = new LR01ResearchFacade();
      const recipe: LR01Recipe = {
        citation: 'https://docs.sangfor.com/iag/13.0/admin',
        pageVerified: true,
        productApplicability: 'IAG',
        versionApplicability: '13.0.120',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.eligibleForPromotion).toBe(true);
      }
    });

    it('marks as not eligible without product/version applicability', async () => {
      const facade = new LR01ResearchFacade();
      const recipe: LR01Recipe = {
        citation: 'https://docs.sangfor.com/iag/13.0/admin',
        pageVerified: true,
      };

      const result = await facade.execute(recipe);
      expect('eligibleForPromotion' in result).toBe(true);
      if ('eligibleForPromotion' in result) {
        expect(result.eligibleForPromotion).toBe(false);
      }
    });
  });

  describe('validateLR02Recipe', () => {
    it('accepts valid recipe without secrets', () => {
      const recipe: LR02Recipe = {
        captureStructure: 'version,license,interfaces',
        allowlist: ['version', 'license'],
      };
      const result = validateLR02Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe with raw secret in capture structure', () => {
      const recipe: LR02Recipe = {
        captureStructure: 'version,password,license',
        allowlist: ['version'],
      };
      const result = validateLR02Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('RAW_SECRET_DETECTED'))).toBe(true);
    });

    it('rejects recipe with raw secret in allowlist', () => {
      const recipe: LR02Recipe = {
        captureStructure: 'version,license',
        allowlist: ['version', 'api_key'],
      };
      const result = validateLR02Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('RAW_SECRET_DETECTED'))).toBe(true);
    });
  });

  describe('LR02BenchmarkFacade', () => {
    it('executes valid recipe and returns benchmark score', async () => {
      const facade = new LR02BenchmarkFacade();
      const recipe: LR02Recipe = {
        captureStructure: 'version,license,interfaces',
        allowlist: ['version', 'license'],
      };

      const result = await facade.execute(recipe);
      expect('benchmarkScore' in result).toBe(true);
      if ('benchmarkScore' in result) {
        expect(result.benchmarkScore).toBeGreaterThan(0);
      }
    });
  });

  describe('validateLR03Recipe', () => {
    it('accepts valid recipe without framework assumption', () => {
      const recipe: LR03Recipe = {
        frameworkProbe: 'detect-framework',
        routeProbe: 'enumerate-routes',
        capabilityProbe: 'check-capabilities',
      };
      const result = validateLR03Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('LR03ProbeFacade', () => {
    it('executes valid recipe without framework assumption', async () => {
      const facade = new LR03ProbeFacade({ syntheticMode: true });
      const recipe: LR03Recipe = {
        frameworkProbe: 'detect-framework',
        routeProbe: 'enumerate-routes',
        capabilityProbe: 'check-capabilities',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.detectedFramework).toBeUndefined();
        expect(result.routes.length).toBeGreaterThan(0);
        expect(result.capabilities.length).toBeGreaterThan(0);
      }
    });
  });

  describe('LR04BenchmarkFacade', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LR04BenchmarkFacade({ syntheticMode: true });
      const recipe: LR04Recipe = {
        baselineStrategyId: 'strategy-baseline',
        candidateStrategyId: 'strategy-candidate',
        metrics: ['latency', 'coverage'],
      };

      const result = await facade.execute(recipe);
      expect('metrics' in result).toBe(true);
      if ('metrics' in result) {
        expect(result.metrics.latency).toBeDefined();
        expect(result.metrics.coverage).toBeDefined();
        expect(result.hasEvidenceFile).toBe(false);
      }
    });
  });

  describe('Stale candidate workflow', () => {
    it('creates stale candidate', () => {
      const candidate = createStaleCandidate('rev-1', 'strategy-1', 'fingerprint mismatch');
      expect(candidate.revisionId).toBe('rev-1');
      expect(candidate.strategyId).toBe('strategy-1');
      expect(candidate.reason).toBe('fingerprint mismatch');
      expect(candidate.confirmed).toBe(false);
    });

    it('confirms stale candidate', () => {
      const candidate = createStaleCandidate('rev-1', 'strategy-1', 'fingerprint mismatch');
      const confirmed = confirmStaleCandidate(candidate);
      expect(confirmed.confirmed).toBe(true);
    });
  });
});
