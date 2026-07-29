import { describe, it, expect } from 'vitest';
import {
  getMethodSchema,
  validateMethodRecipe,
  computeValueDigest,
  isCompleteResult,
  isTerminalResult,
  shouldAbortRun,
  type MethodRecipe,
  type MethodResult,
} from '../packages/sangfor-learning-strategy/src/methods.js';

describe('PR-001C: Learning method contracts', () => {
  describe('getMethodSchema', () => {
    it('returns LM-01 schema with required fields', () => {
      const schema = getMethodSchema('LM-01');
      expect(schema.code).toBe('LM-01');
      expect(schema.version).toBe(1);
      expect(schema.requiredFields).toContain('endpoint');
      expect(schema.requiredFields).toContain('method');
      expect(schema.requiredFields).toContain('citation');
    });

    it('returns LM-08 schema with reviewer/identity/nonce/expiry', () => {
      const schema = getMethodSchema('LM-08');
      expect(schema.requiredFields).toContain('observationDigest');
      expect(schema.requiredFields).toContain('reviewer');
      expect(schema.requiredFields).toContain('identity');
      expect(schema.requiredFields).toContain('nonce');
      expect(schema.requiredFields).toContain('expiry');
    });

    it('returns LR-01 schema with citation and pageVerified', () => {
      const schema = getMethodSchema('LR-01');
      expect(schema.requiredFields).toContain('citation');
      expect(schema.requiredFields).toContain('pageVerified');
    });
  });

  describe('validateMethodRecipe — unknown-key rejection', () => {
    it('accepts valid LM-01 recipe', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          citation: 'https://docs.example.com/api',
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects recipe with unknown field', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          citation: 'https://docs.example.com/api',
          unknownField: 'should-be-rejected',
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Unknown field: unknownField');
    });

    it('rejects recipe with forbidden field (shell)', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          citation: 'https://docs.example.com/api',
          shell: 'rm -rf /',
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Forbidden field present: shell');
    });

    it('rejects recipe with forbidden field (regex)', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          citation: 'https://docs.example.com/api',
          regex: '.*',
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Forbidden field present: regex');
    });

    it('rejects recipe with missing required field', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          // missing citation
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: citation');
    });

    it('rejects recipe with invalid schema version', () => {
      const recipe: MethodRecipe = {
        methodCode: 'LM-01',
        schemaVersion: 2 as 1,
        fields: {
          endpoint: '/api/status',
          method: 'GET',
          citation: 'https://docs.example.com/api',
        },
      };
      const result = validateMethodRecipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('schema version'))).toBe(true);
    });
  });

  describe('LM-02 user approval gate', () => {
    it('LM-02 schema forbids shell/regex/functionName/urlHost/headerValue', () => {
      const schema = getMethodSchema('LM-02');
      expect(schema.forbiddenFields).toContain('shell');
      expect(schema.forbiddenFields).toContain('regex');
      expect(schema.forbiddenFields).toContain('functionName');
      expect(schema.forbiddenFields).toContain('urlHost');
      expect(schema.forbiddenFields).toContain('headerValue');
    });
  });

  describe('LM-05 file limits', () => {
    it('LM-05 schema forbids symlink/pathTraversal', () => {
      const schema = getMethodSchema('LM-05');
      expect(schema.forbiddenFields).toContain('symlink');
      expect(schema.forbiddenFields).toContain('pathTraversal');
    });
  });

  describe('LM-07 OCR restrictions', () => {
    it('LM-07 schema forbids pixelStorage/rawOcrText/autoPass', () => {
      const schema = getMethodSchema('LM-07');
      expect(schema.forbiddenFields).toContain('pixelStorage');
      expect(schema.forbiddenFields).toContain('rawOcrText');
      expect(schema.forbiddenFields).toContain('autoPass');
    });
  });

  describe('LM-08 signature restrictions', () => {
    it('LM-08 schema forbids forgedBoolean/freeFormSecret', () => {
      const schema = getMethodSchema('LM-08');
      expect(schema.forbiddenFields).toContain('forgedBoolean');
      expect(schema.forbiddenFields).toContain('freeFormSecret');
    });
  });

  describe('computeValueDigest', () => {
    it('produces deterministic SHA-256 hex digest', () => {
      const value = { key: 'value', nested: { a: 1 } };
      const digest1 = computeValueDigest(value);
      const digest2 = computeValueDigest(value);
      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('result status helpers', () => {
    it('isCompleteResult returns true only for complete', () => {
      expect(isCompleteResult({ methodCode: 'LM-01', status: 'complete' })).toBe(true);
      expect(isCompleteResult({ methodCode: 'LM-01', status: 'partial' })).toBe(false);
    });

    it('isTerminalResult returns true for terminal statuses', () => {
      expect(isTerminalResult({ methodCode: 'LM-01', status: 'complete' })).toBe(true);
      expect(isTerminalResult({ methodCode: 'LM-01', status: 'partial' })).toBe(true);
      expect(isTerminalResult({ methodCode: 'LM-01', status: 'blocked' })).toBe(true);
      expect(isTerminalResult({ methodCode: 'LM-01', status: 'not_observed' })).toBe(false);
    });

    it('shouldAbortRun returns true for abort statuses', () => {
      expect(shouldAbortRun({ methodCode: 'LM-01', status: 'blocked' })).toBe(true);
      expect(shouldAbortRun({ methodCode: 'LM-01', status: 'integrity_error' })).toBe(true);
      expect(shouldAbortRun({ methodCode: 'LM-01', status: 'mutation_signal' })).toBe(true);
      expect(shouldAbortRun({ methodCode: 'LM-01', status: 'complete' })).toBe(false);
    });
  });
});
