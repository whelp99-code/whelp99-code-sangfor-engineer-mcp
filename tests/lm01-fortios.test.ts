import { describe, it, expect } from 'vitest';
import {
  LM01FortiosFacade,
  validateLM01Recipe,
  FORTIOS_8_0_SYNTHETIC_FIXTURE,
  type LM01Recipe,
} from '../packages/sangfor-learning-strategy/src/lm01-fortios.js';

describe('PR-003: LM-01 FortiOS', () => {
  describe('validateLM01Recipe', () => {
    it('accepts valid GET recipe with citation', () => {
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
      };
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid HEAD recipe with citation', () => {
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'HEAD',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
      };
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(true);
    });

    it('rejects recipe without citation', () => {
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: '',
      };
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MISSING_CITATION'))).toBe(true);
    });

    it('rejects recipe without endpoint', () => {
      const recipe: LM01Recipe = {
        endpoint: '',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
      };
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MISSING_ENDPOINT'))).toBe(true);
    });

    it('rejects recipe with invalid method (POST)', () => {
      const recipe = ({
        endpoint: '/api/v1/system/status',
        method: 'POST',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
      } as unknown) as LM01Recipe;
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('INVALID_METHOD'))).toBe(true);
    });

    it('rejects recipe with forbidden field (shell)', () => {
      const recipe = ({
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
        shell: 'rm -rf /',
      } as unknown) as LM01Recipe;
      const result = validateLM01Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORBIDDEN_FIELD'))).toBe(true);
    });
  });

  describe('LM01FortiosFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM01FortiosFacade({ syntheticMode: true });
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
        keyPaths: ['version'],
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('version');
        expect(result.value).toBe('8.0.0');
        expect(result.citation).toBe(recipe.citation);
      }
    });

    it('returns SYNTHETIC_ONLY error in non-synthetic mode', async () => {
      const facade = new LM01FortiosFacade({ syntheticMode: false });
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
      };

      const result = await facade.execute(recipe);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('SYNTHETIC_ONLY');
      }
    });

    it('extracts nested key paths', async () => {
      const facade = new LM01FortiosFacade({ syntheticMode: true });
      const recipe: LM01Recipe = {
        endpoint: '/api/v1/system/status',
        method: 'GET',
        citation: 'https://docs.fortinet.com/document/fortios/8.0.0/rest-api',
        keyPaths: ['license.status'],
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('license.status');
        expect(result.value).toBe('valid');
      }
    });
  });

  describe('FORTIOS_8_0_SYNTHETIC_FIXTURE', () => {
    it('contains version 8.0.0', () => {
      expect(FORTIOS_8_0_SYNTHETIC_FIXTURE.version).toBe('8.0.0');
    });

    it('contains valid license', () => {
      expect(FORTIOS_8_0_SYNTHETIC_FIXTURE.license.status).toBe('valid');
    });

    it('contains interfaces', () => {
      expect(FORTIOS_8_0_SYNTHETIC_FIXTURE.interfaces).toHaveLength(2);
    });
  });
});
