import { describe, it, expect } from 'vitest';
import {
  LM03ExtjsFacade,
  LM04DomFacade,
  validateLM03Recipe,
  validateLM04Recipe,
  IAG_13_0_120_SYNTHETIC_FIXTURE,
  type LM03Recipe,
  type LM04Recipe,
} from '../packages/sangfor-learning-strategy/src/lm03-extjs.js';

describe('PR-006: LM-03 ExtJS and LM-04 DOM', () => {
  describe('validateLM03Recipe', () => {
    it('accepts valid recipe with storeId and fields', () => {
      const recipe: LM03Recipe = {
        storeId: 'SystemStore',
        fields: ['version', 'licenseStatus'],
      };
      const result = validateLM03Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe without storeId', () => {
      const recipe: LM03Recipe = {
        storeId: '',
        fields: ['version'],
      };
      const result = validateLM03Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('STORE_NOT_FOUND'))).toBe(true);
    });

    it('rejects recipe without fields', () => {
      const recipe: LM03Recipe = {
        storeId: 'SystemStore',
        fields: [],
      };
      const result = validateLM03Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FIELD_NOT_ALLOWLISTED'))).toBe(true);
    });
  });

  describe('LM03ExtjsFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM03ExtjsFacade({ syntheticMode: true });
      const recipe: LM03Recipe = {
        storeId: 'SystemStore',
        fields: ['version'],
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('version');
        expect(result.value).toBe('13.0.120');
        expect(result.storeId).toBe('SystemStore');
      }
    });
  });

  describe('validateLM04Recipe', () => {
    it('accepts valid recipe with selectors', () => {
      const recipe: LM04Recipe = {
        selectors: ['.version-display', '.license-status'],
      };
      const result = validateLM04Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe without selectors', () => {
      const recipe: LM04Recipe = {
        selectors: [],
      };
      const result = validateLM04Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('SELECTOR_NOT_ALLOWLISTED'))).toBe(true);
    });
  });

  describe('LM04DomFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM04DomFacade({ syntheticMode: true });
      const recipe: LM04Recipe = {
        selectors: ['.version-display'],
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('.version-display');
        expect(result.value).toBe('13.0.120');
        expect(result.selector).toBe('.version-display');
      }
    });
  });

  describe('IAG_13_0_120_SYNTHETIC_FIXTURE', () => {
    it('contains version 13.0.120', () => {
      expect(IAG_13_0_120_SYNTHETIC_FIXTURE.version).toBe('13.0.120');
    });

    it('contains ExtJS stores', () => {
      expect(IAG_13_0_120_SYNTHETIC_FIXTURE.extjsStores).toContain('SystemStore');
      expect(IAG_13_0_120_SYNTHETIC_FIXTURE.extjsStores).toContain('LicenseStore');
    });

    it('contains DOM selectors', () => {
      expect(IAG_13_0_120_SYNTHETIC_FIXTURE.domSelectors).toContain('.version-display');
      expect(IAG_13_0_120_SYNTHETIC_FIXTURE.domSelectors).toContain('.license-status');
    });
  });
});
