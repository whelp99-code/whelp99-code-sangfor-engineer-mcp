import { describe, it, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { buildOperationsGuideDocx } from '../packages/sangfor-product-adapters/src/docx-builder.js';

describe('buildOperationsGuideDocx', () => {
  it('generates a valid docx file', () => {
    const outPath = '/tmp/test-ops-guide-verify.docx';
    if (existsSync(outPath)) rmSync(outPath);
    const result = buildOperationsGuideDocx({ outputPath: outPath });
    expect(result.docxPath).toBe(outPath);
    expect(result.size).toBeGreaterThan(0);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections).toContain('1. 일일 모니터링 절차');
    expect(result.sections).toContain('3. 장애 대응 절차');
    expect(result.sections).toContain('4. 보안 정책 관리');
    expect(existsSync(outPath)).toBe(true);
    rmSync(outPath);
  });
});
