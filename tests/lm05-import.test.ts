import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  LM05ImportFacade,
  LM06StreamFacade,
  validateLM05Recipe,
  validateLM06Recipe,
  isPathTraversal,
  LM05_LIMITS,
  type LM05Recipe,
  type LM06Recipe,
} from '../packages/sangfor-learning-strategy/src/lm05-import.js';

describe('PR-007: LM-05 Import and LM-06 Stream', () => {
  describe('LM05_LIMITS', () => {
    it('has correct limits', () => {
      expect(LM05_LIMITS.maxFileSize).toBe(50 * 1024 * 1024);
      expect(LM05_LIMITS.maxRows).toBe(100_000);
      expect(LM05_LIMITS.maxFieldsPerRow).toBe(256);
      expect(LM05_LIMITS.maxStringLength).toBe(64 * 1024);
      expect(LM05_LIMITS.parseTimeoutMs).toBe(30_000);
    });
  });

  describe('validateLM05Recipe', () => {
    it('accepts valid JSON recipe', () => {
      const recipe: LM05Recipe = {
        importRoot: '/data/imports',
        filePattern: 'config.json',
        format: 'json',
      };
      const result = validateLM05Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid CSV recipe', () => {
      const recipe: LM05Recipe = {
        importRoot: '/data/imports',
        filePattern: 'data.csv',
        format: 'csv',
      };
      const result = validateLM05Recipe(recipe);
      expect(result.valid).toBe(true);
    });

    it('rejects recipe without importRoot', () => {
      const recipe: LM05Recipe = {
        importRoot: '',
        filePattern: 'config.json',
        format: 'json',
      };
      const result = validateLM05Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FILE_NOT_FOUND'))).toBe(true);
    });

    it('rejects recipe with invalid format', () => {
      const recipe = ({
        importRoot: '/data/imports',
        filePattern: 'config.xml',
        format: 'xml',
      } as unknown) as LM05Recipe;
      const result = validateLM05Recipe(recipe);
      expect(result.valid).toBe(false);
    });
  });

  describe('isPathTraversal', () => {
    it('detects path traversal', () => {
      expect(isPathTraversal('/data/imports', '/data/imports/../secrets.json')).toBe(true);
      expect(isPathTraversal('/data/imports', '/etc/passwd')).toBe(true);
    });

    it('allows valid paths', () => {
      expect(isPathTraversal('/data/imports', '/data/imports/config.json')).toBe(false);
      expect(isPathTraversal('/data/imports', '/data/imports/subdir/data.csv')).toBe(false);
    });
  });

  describe('LM05ImportFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM05ImportFacade({ syntheticMode: true });
      const recipe: LM05Recipe = {
        importRoot: '/data/imports',
        filePattern: 'config.json',
        format: 'json',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('import');
        expect(result.rowCount).toBeGreaterThan(0);
      }
    });
  });

  describe('LM05ImportFacade — real JSON input', () => {
    it('refuses a malformed JSON line instead of silently dropping it', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lm05-malformed-'));
      try {
        writeFileSync(join(root, 'config.json'), '{"valid":true}\n{not-json}\n');
        const facade = new LM05ImportFacade({ syntheticMode: false });

        const result = await facade.execute({
          importRoot: root,
          filePattern: 'config.json',
          format: 'json',
        });

        expect(result).toEqual({
          code: 'MALFORMED_JSON',
          message: 'Malformed JSON in config.json.',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('validateLM06Recipe', () => {
    it('accepts valid WebSocket recipe', () => {
      const recipe: LM06Recipe = {
        frameListener: 'statusListener',
        streamType: 'websocket',
      };
      const result = validateLM06Recipe(recipe);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid SSE recipe', () => {
      const recipe: LM06Recipe = {
        frameListener: 'eventListener',
        streamType: 'sse',
      };
      const result = validateLM06Recipe(recipe);
      expect(result.valid).toBe(true);
    });

    it('rejects recipe without frameListener', () => {
      const recipe: LM06Recipe = {
        frameListener: '',
        streamType: 'websocket',
      };
      const result = validateLM06Recipe(recipe);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('STREAM_NOT_FOUND'))).toBe(true);
    });

    it('rejects recipe with invalid streamType', () => {
      const recipe = ({
        frameListener: 'listener',
        streamType: 'http',
      } as unknown) as LM06Recipe;
      const result = validateLM06Recipe(recipe);
      expect(result.valid).toBe(false);
    });
  });

  describe('LM06StreamFacade — synthetic mode', () => {
    it('executes valid recipe in synthetic mode', async () => {
      const facade = new LM06StreamFacade({ syntheticMode: true });
      const recipe: LM06Recipe = {
        frameListener: 'statusListener',
        streamType: 'websocket',
      };

      const result = await facade.execute(recipe);
      expect('factId' in result).toBe(true);
      if ('factId' in result) {
        expect(result.factId).toBe('statusListener');
        expect(result.frameCount).toBe(1);
      }
    });

    it('tracks frame count correctly', async () => {
      const facade = new LM06StreamFacade({ syntheticMode: true });
      const recipe: LM06Recipe = {
        frameListener: 'statusListener',
        streamType: 'websocket',
      };

      await facade.execute(recipe);
      await facade.execute(recipe);
      const result = await facade.execute(recipe);

      expect('frameCount' in result).toBe(true);
      if ('frameCount' in result) {
        expect(result.frameCount).toBe(3);
      }
      expect(facade.getFrameCount()).toBe(3);
    });
  });
});
