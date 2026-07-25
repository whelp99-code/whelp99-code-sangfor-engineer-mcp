import { describe, it, expect } from 'vitest';
import {
  LM02ReplayFacade,
  validateLM02Recipe,
  CC_3_0_98_SYNTHETIC_FIXTURE,
  CC_VERSION_CONFLICT_FIXTURE,
  type LM02Recipe,
} from '../packages/sangfor-learning-strategy/src/lm02-replay.js';

describe('PR-005: LM-02 Replay', () => {
  describe('validateLM02Recipe', () => {
    it('accepts valid GET recipe', () => {
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };
      const result = validateLM02Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid HEAD recipe', () => {
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'HEAD',
      };
      const result = validateLM02Recipe(recipe);
      expect(result.valid).toBe(true);
    });

    it('accepts read-only POST with template flag', () => {
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/query',
        method: 'POST',
        readOnlyPostTemplate: true,
        body: { query: 'version' },
      };
      const result = validateLM02Recipe(recipe);
      expect(result.valid).toBe(true);
    });

    it('rejects POST without readOnlyPostTemplate flag', () => {
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/query',
        method: 'POST',
        body: { query: 'version' },
      };
      const result = validateLM02Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('INVALID_METHOD'))).toBe(true);
    });

    it('rejects recipe with forbidden field (shell)', () => {
      const recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        shell: 'rm -rf /',
      } as LM02Recipe;
      const result = validateLM02Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORBIDDEN_FIELD'))).toBe(true);
    });
  });

  describe('LM02ReplayFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM02ReplayFacade({ syntheticMode: true });
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('version');
        expect(result.value).toBe('3.0.98');
        expect(result.requestCount).toBe(1);
      }
    });

    it('tracks request count correctly', async () => {
      const facade = new LM02ReplayFacade({ syntheticMode: true });
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };

      await facade.execute(recipe);
      await facade.execute(recipe);
      const result = await facade.execute(recipe);

      expect('requestCount' in result).toBe(true);
      if ('requestCount' in result) {
        expect(result.requestCount).toBe(3);
      }
      expect(facade.getRequestCount()).toBe(3);
    });

    it('resets request count', async () => {
      const facade = new LM02ReplayFacade({ syntheticMode: true });
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };

      await facade.execute(recipe);
      facade.resetRequestCount();
      expect(facade.getRequestCount()).toBe(0);
    });
  });

  describe('LM02ReplayFacade — user approval gate', () => {
    it('returns ACTIVE_REPLAY_NOT_APPROVED in real mode without approval', async () => {
      const facade = new LM02ReplayFacade({ syntheticMode: false, userApproved: false });
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };

      const result = await facade.execute(recipe);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('ACTIVE_REPLAY_NOT_APPROVED');
        expect(result.message).toContain('U-02');
      }
    });

    it('executes in real mode with user approval', async () => {
      const facade = new LM02ReplayFacade({ syntheticMode: false, userApproved: true });
      const recipe: LM02Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.requestCount).toBe(1);
      }
    });
  });

  describe('CC fixtures', () => {
    it('CC_3_0_98_SYNTHETIC_FIXTURE contains version 3.0.98', () => {
      expect(CC_3_0_98_SYNTHETIC_FIXTURE.version).toBe('3.0.98');
      expect(CC_3_0_98_SYNTHETIC_FIXTURE.license.status).toBe('valid');
    });

    it('CC_VERSION_CONFLICT_FIXTURE represents conflict', () => {
      expect(CC_VERSION_CONFLICT_FIXTURE.conflict).toBe(true);
      expect(CC_VERSION_CONFLICT_FIXTURE.candidate1.version).toBe('3.0.98');
      expect(CC_VERSION_CONFLICT_FIXTURE.candidate2.version).toBe('3.0.98C');
      expect(CC_VERSION_CONFLICT_FIXTURE.resolution).toBe('pending_m2_verification');
    });
  });
});
