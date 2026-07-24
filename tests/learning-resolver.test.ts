import { describe, it, expect } from 'vitest';
import {
  resolveExactStrategy,
  resolveMethodChain,
  isStateUsableForEnvironment,
  validateRegistryDigest,
  validateVersionTruth,
  type ResolverContext,
  type StrategyScope,
} from '../packages/sangfor-learning-strategy/src/resolver.js';
import { foldLifecycle, isValidTransition, isCompetencyCountingState, requiresSeparateWorkAtomPromotion, type LifecycleEvent } from '../packages/sangfor-learning-strategy/src/lifecycle.js';
import type { StrategyRevision } from '../packages/sangfor-learning-strategy/src/store.js';
import type { MethodResult } from '../packages/sangfor-learning-strategy/src/methods.js';

describe('PR-001C: Strategy resolver', () => {
  const baseContext: ResolverContext = {
    registryDigest: 'registry-digest-123',
    versionTruthRecord: 'version-truth-456',
    environment: 'lab',
  };

  const baseScope: StrategyScope = {
    product: 'ENDPOINT_SECURE',
    firmwareVersion: '6.0.4',
  };

  function makeRevision(state: StrategyRevision['state'], id: string = 'rev-1'): StrategyRevision {
    return {
      revisionId: id,
      strategyId: 'strategy-1',
      state,
      contentHash: 'content-hash',
      createdAt: '2026-07-25T00:00:00.000Z',
    };
  }

  describe('isStateUsableForEnvironment', () => {
    it('researched is not usable (canary/explanation only)', () => {
      expect(isStateUsableForEnvironment('researched', 'lab')).toBe(false);
      expect(isStateUsableForEnvironment('researched', 'production')).toBe(false);
    });

    it('lab_verified is usable only in lab', () => {
      expect(isStateUsableForEnvironment('lab_verified', 'lab')).toBe(true);
      expect(isStateUsableForEnvironment('lab_verified', 'poc')).toBe(false);
      expect(isStateUsableForEnvironment('lab_verified', 'production')).toBe(false);
    });

    it('device_verified is usable in lab/poc/customer but not production', () => {
      expect(isStateUsableForEnvironment('device_verified', 'lab')).toBe(true);
      expect(isStateUsableForEnvironment('device_verified', 'poc')).toBe(true);
      expect(isStateUsableForEnvironment('device_verified', 'customer')).toBe(true);
      expect(isStateUsableForEnvironment('device_verified', 'production')).toBe(false);
    });

    it('strategy_field_verified is usable in all environments', () => {
      expect(isStateUsableForEnvironment('strategy_field_verified', 'lab')).toBe(true);
      expect(isStateUsableForEnvironment('strategy_field_verified', 'production')).toBe(true);
    });

    it('draft/stale/deprecated are not usable', () => {
      expect(isStateUsableForEnvironment('draft', 'lab')).toBe(false);
      expect(isStateUsableForEnvironment('stale', 'lab')).toBe(false);
      expect(isStateUsableForEnvironment('deprecated', 'lab')).toBe(false);
    });
  });

  describe('resolveExactStrategy', () => {
    it('resolves single eligible revision', () => {
      const revisions = [makeRevision('lab_verified')];
      const result = resolveExactStrategy(revisions, baseScope, baseContext);
      expect('revision' in result).toBe(true);
      if ('revision' in result) {
        expect(result.revision.state).toBe('lab_verified');
      }
    });

    it('returns NO_ELIGIBLE_STRATEGY when no revisions match', () => {
      const revisions = [makeRevision('draft')];
      const result = resolveExactStrategy(revisions, baseScope, baseContext);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('NO_ELIGIBLE_STRATEGY');
      }
    });

    it('returns AMBIGUOUS_STRATEGY when 2+ active revisions', () => {
      const revisions = [
        makeRevision('lab_verified', 'rev-1'),
        makeRevision('lab_verified', 'rev-2'),
      ];
      const result = resolveExactStrategy(revisions, baseScope, baseContext);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('AMBIGUOUS_STRATEGY');
      }
    });

    it('returns NEAR_VERSION_ONLY for near-version candidates (explanation-only)', () => {
      const revisions = [makeRevision('lab_verified')];
      const context: ResolverContext = { ...baseContext, environment: 'production' };
      const result = resolveExactStrategy(revisions, baseScope, context);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('NEAR_VERSION_ONLY');
        expect('candidates' in result).toBe(true);
      }
    });
  });

  describe('resolveMethodChain', () => {
    it('collects facts from complete results', () => {
      const results: MethodResult[] = [
        { methodCode: 'LM-01', status: 'complete', facts: { version: '6.0.4' } },
        { methodCode: 'LM-03', status: 'complete', facts: { license: 'active' } },
      ];
      const { facts, conflicts, aborted } = resolveMethodChain(results);
      expect(facts).toEqual({ version: '6.0.4', license: 'active' });
      expect(conflicts).toHaveLength(0);
      expect(aborted).toBe(false);
    });

    it('skips not_applicable and not_observed results', () => {
      const results: MethodResult[] = [
        { methodCode: 'LM-01', status: 'not_applicable' },
        { methodCode: 'LM-02', status: 'not_observed' },
        { methodCode: 'LM-03', status: 'complete', facts: { license: 'active' } },
      ];
      const { facts } = resolveMethodChain(results);
      expect(facts).toEqual({ license: 'active' });
    });

    it('aborts run on blocked/integrity_error/mutation_signal', () => {
      const results: MethodResult[] = [
        { methodCode: 'LM-01', status: 'complete', facts: { version: '6.0.4' } },
        { methodCode: 'LM-02', status: 'mutation_signal' },
        { methodCode: 'LM-03', status: 'complete', facts: { license: 'active' } },
      ];
      const { facts, aborted } = resolveMethodChain(results);
      expect(aborted).toBe(true);
      expect(facts).toEqual({ version: '6.0.4' }); // LM-03 not processed
    });

    it('detects conflict when 2+ complete values differ', () => {
      const results: MethodResult[] = [
        { methodCode: 'LM-01', status: 'complete', facts: { version: '6.0.4' }, evidenceDigest: 'digest-1' },
        { methodCode: 'LM-03', status: 'complete', facts: { version: '6.0.5' }, evidenceDigest: 'digest-2' },
      ];
      const { facts, conflicts } = resolveMethodChain(results);
      expect(facts.version).toBe('6.0.4'); // First value wins
      expect(conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('validateRegistryDigest / validateVersionTruth', () => {
    it('returns true for matching digests', () => {
      expect(validateRegistryDigest('abc', 'abc')).toBe(true);
      expect(validateVersionTruth('xyz', 'xyz')).toBe(true);
    });

    it('returns false for mismatched digests', () => {
      expect(validateRegistryDigest('abc', 'def')).toBe(false);
      expect(validateVersionTruth('xyz', 'uvw')).toBe(false);
    });
  });
});

describe('PR-001C: Lifecycle fold', () => {
  describe('isValidTransition', () => {
    it('allows draft -> researched', () => {
      expect(isValidTransition('draft', 'researched')).toBe(true);
    });

    it('allows researched -> lab_verified', () => {
      expect(isValidTransition('researched', 'lab_verified')).toBe(true);
    });

    it('allows lab_verified -> device_verified', () => {
      expect(isValidTransition('lab_verified', 'device_verified')).toBe(true);
    });

    it('allows device_verified -> strategy_field_verified', () => {
      expect(isValidTransition('device_verified', 'strategy_field_verified')).toBe(true);
    });

    it('rejects invalid transitions', () => {
      expect(isValidTransition('draft', 'lab_verified')).toBe(false);
      expect(isValidTransition('draft', 'strategy_field_verified')).toBe(false);
      expect(isValidTransition('deprecated', 'draft')).toBe(false);
    });
  });

  describe('foldLifecycle', () => {
    it('returns draft for empty events', () => {
      expect(foldLifecycle([])).toBe('draft');
    });

    it('folds valid transition sequence', () => {
      const events: LifecycleEvent[] = [
        { eventType: 'transition', fromState: 'draft', toState: 'researched', revisionId: 'rev-1', timestamp: '2026-07-25T00:00:00.000Z' },
        { eventType: 'transition', fromState: 'researched', toState: 'lab_verified', revisionId: 'rev-2', timestamp: '2026-07-25T01:00:00.000Z' },
      ];
      expect(foldLifecycle(events)).toBe('lab_verified');
    });

    it('throws on invalid transition', () => {
      const events: LifecycleEvent[] = [
        { eventType: 'transition', fromState: 'draft', toState: 'lab_verified', revisionId: 'rev-1', timestamp: '2026-07-25T00:00:00.000Z' },
      ];
      expect(() => foldLifecycle(events)).toThrow('INVALID_TRANSITION');
    });

    it('handles system_stale event', () => {
      const events: LifecycleEvent[] = [
        { eventType: 'transition', fromState: 'draft', toState: 'researched', revisionId: 'rev-1', timestamp: '2026-07-25T00:00:00.000Z' },
        { eventType: 'system_stale', fromState: 'researched', toState: 'stale', revisionId: 'rev-1', timestamp: '2026-07-25T01:00:00.000Z' },
      ];
      expect(foldLifecycle(events)).toBe('stale');
    });
  });

  describe('strategy_field_verified vs competency boundary', () => {
    it('isCompetencyCountingState returns false for all strategy states', () => {
      expect(isCompetencyCountingState('draft')).toBe(false);
      expect(isCompetencyCountingState('researched')).toBe(false);
      expect(isCompetencyCountingState('lab_verified')).toBe(false);
      expect(isCompetencyCountingState('device_verified')).toBe(false);
      expect(isCompetencyCountingState('strategy_field_verified')).toBe(false);
      expect(isCompetencyCountingState('stale')).toBe(false);
      expect(isCompetencyCountingState('deprecated')).toBe(false);
    });

    it('requiresSeparateWorkAtomPromotion returns true only for strategy_field_verified', () => {
      expect(requiresSeparateWorkAtomPromotion('strategy_field_verified')).toBe(true);
      expect(requiresSeparateWorkAtomPromotion('draft')).toBe(false);
      expect(requiresSeparateWorkAtomPromotion('lab_verified')).toBe(false);
    });
  });
});
