import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PR-001A1 ADAPTERS-derived registry package edges', () => {
  it('keeps package edges explicit and prevents learning/version from importing product adapters', () => {
    const manifest = JSON.parse(readFileSync(new URL('../packages/sangfor-product-adapters/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toMatchObject({
      '@sangfor/approval': 'workspace:*',
      '@sangfor/operator': 'workspace:*',
      '@sangfor/shared': 'workspace:*',
      '@sangfor/learning-strategy': 'workspace:*',
    });
    const productTypeSource = readFileSync(new URL('../packages/sangfor-product-adapters/src/types.ts', import.meta.url), 'utf8');
    expect(productTypeSource).toContain("import type {");
    expect(productTypeSource).toContain("from '@sangfor/learning-strategy';");
    expect(readFileSync(new URL('../packages/sangfor-learning-strategy/src/index.ts', import.meta.url), 'utf8'))
      .not.toContain('@sangfor/product-adapters');
    expect(readFileSync(new URL('../packages/sangfor-version/src/index.ts', import.meta.url), 'utf8'))
      .not.toContain('@sangfor/product-adapters');
  });
});
