import { describe, it, expect } from 'vitest';
import {
  LM07OcrFacade,
  LM08ConfirmationFacade,
  validateLM07Recipe,
  validateLM08Recipe,
  type LM07Recipe,
  type LM08Recipe,
} from '../packages/sangfor-learning-strategy/src/lm07-ocr.js';

describe('PR-008: LM-07 OCR and LM-08 Confirmation', () => {
  describe('validateLM07Recipe', () => {
    it('accepts valid recipe with ROI and typeParser', () => {
      const recipe: LM07Recipe = {
        roi: { x: 100, y: 200, width: 300, height: 50 },
        typeParser: 'version',
      };
      const result = validateLM07Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe without ROI', () => {
      const recipe = ({
        roi: null,
        typeParser: 'version',
      } as unknown) as LM07Recipe;
      const result = validateLM07Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('INVALID_ROI'))).toBe(true);
    });

    it('rejects recipe with invalid ROI dimensions', () => {
      const recipe: LM07Recipe = {
        roi: { x: 100, y: 200, width: -1, height: 50 },
        typeParser: 'version',
      };
      const result = validateLM07Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('INVALID_ROI'))).toBe(true);
    });

    it('rejects recipe with invalid typeParser', () => {
      const recipe = ({
        roi: { x: 100, y: 200, width: 300, height: 50 },
        typeParser: 'invalid',
      } as unknown) as LM07Recipe;
      const result = validateLM07Recipe(recipe);
      expect(result.valid).toBe(false);
    });
  });

  describe('LM07OcrFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM07OcrFacade({ syntheticMode: true });
      const recipe: LM07Recipe = {
        roi: { x: 100, y: 200, width: 300, height: 50 },
        typeParser: 'version',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('version');
        expect(result.value).toBe('13.0.120');
        expect(result.reviewRequired).toBe(true);
      }
    });

    it('always requires review for LM-07', async () => {
      const facade = new LM07OcrFacade({ syntheticMode: true });
      const recipe: LM07Recipe = {
        roi: { x: 100, y: 200, width: 300, height: 50 },
        typeParser: 'license',
      };

      const result = await facade.execute(recipe);
      expect('reviewRequired' in result).toBe(true);
      if ('reviewRequired' in result) {
        expect(result.reviewRequired).toBe(true);
      }
    });
  });

  describe('validateLM08Recipe', () => {
    it('accepts valid recipe with all required fields', () => {
      const recipe: LM08Recipe = {
        observationDigest: 'a'.repeat(64),
        reviewer: 'jmpark',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2027-12-31T23:59:59.000Z',
      };
      const result = validateLM08Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe with invalid observationDigest', () => {
      const recipe: LM08Recipe = {
        observationDigest: 'invalid',
        reviewer: 'jmpark',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2027-12-31T23:59:59.000Z',
      };
      const result = validateLM08Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('INVALID_DIGEST'))).toBe(true);
    });

    it('rejects recipe without reviewer', () => {
      const recipe: LM08Recipe = {
        observationDigest: 'a'.repeat(64),
        reviewer: '',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2027-12-31T23:59:59.000Z',
      };
      const result = validateLM08Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORBIDDEN_FIELD'))).toBe(true);
    });

    it('rejects recipe with forbidden field (forgedBoolean)', () => {
      const recipe = {
        observationDigest: 'a'.repeat(64),
        reviewer: 'jmpark',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2027-12-31T23:59:59.000Z',
        forgedBoolean: true,
      } as LM08Recipe;
      const result = validateLM08Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORBIDDEN_FIELD'))).toBe(true);
    });
  });

  describe('LM08ConfirmationFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM08ConfirmationFacade({ syntheticMode: true });
      const recipe: LM08Recipe = {
        observationDigest: 'a'.repeat(64),
        reviewer: 'jmpark',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2027-12-31T23:59:59.000Z',
      };

      const result = await facade.execute(recipe);
      expect('observationDigest' in result).toBe(true);
      if ('observationDigest' in result) {
        expect(result.observationDigest).toBe(recipe.observationDigest);
        expect(result.reviewer).toBe('jmpark');
        expect(result.signature).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('rejects expired confirmation', async () => {
      const facade = new LM08ConfirmationFacade({ syntheticMode: true });
      const recipe: LM08Recipe = {
        observationDigest: 'a'.repeat(64),
        reviewer: 'jmpark',
        identity: 'device-123',
        nonce: 'nonce-456',
        expiry: '2020-01-01T00:00:00.000Z', // Past date
      };

      const result = await facade.execute(recipe);
      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toBe('EXPIRED');
      }
    });
  });
});
