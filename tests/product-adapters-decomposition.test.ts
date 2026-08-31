import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

const PRODUCT_ADAPTER_MODULES = [
  '../packages/sangfor-product-adapters/src/index.ts',
  '../packages/sangfor-product-adapters/src/types.ts',
  '../packages/sangfor-product-adapters/src/product-catalog.ts',
  '../packages/sangfor-product-adapters/src/registry-object.ts',
  '../packages/sangfor-product-adapters/src/registry-codec.ts',
  '../packages/sangfor-product-adapters/src/registry-identity.ts',
  '../packages/sangfor-product-adapters/src/source-mapping.ts',
  '../packages/sangfor-product-adapters/src/requirement-planning.ts',
  '../packages/sangfor-product-adapters/src/xlsx-reader.ts',
  '../packages/sangfor-product-adapters/src/excel-import.ts',
  '../packages/sangfor-product-adapters/src/excel-planning.ts',
  '../packages/sangfor-product-adapters/src/apply-verify.ts',
] as const;

function pureLineCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

describe('Product adapter module boundaries', () => {
  it('keeps the composition root and focused behavior modules within the reviewable size limit', () => {
    const oversized = PRODUCT_ADAPTER_MODULES.flatMap((relativePath) => {
      const fileUrl = new URL(relativePath, import.meta.url);
      if (!existsSync(fileUrl)) return [`${basename(fileUrl.pathname)}:missing`];
      const lines = pureLineCount(readFileSync(fileUrl, 'utf8'));
      return lines > 250 ? [`${basename(fileUrl.pathname)}:${lines}`] : [];
    });

    expect(oversized).toEqual([]);
  });
});
