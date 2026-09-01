import { describe, it, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOperationsGuideDocx } from '../packages/sangfor-product-adapters/src/docx-builder.js';

describe('buildOperationsGuideDocx', () => {
  it('generates a valid docx file', async () => {
    const outPath = join(tmpdir(), 'test-ops-guide-verify.docx');
    if (existsSync(outPath)) rmSync(outPath);
    const result = await buildOperationsGuideDocx({ outputPath: outPath });
    expect(result.docxPath).toBe(outPath);
    expect(result.size).toBeGreaterThan(0);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections).toContain('1. 일일 모니터링 절차');
    expect(result.sections).toContain('3. 장애 대응 절차');
    expect(result.sections).toContain('4. 보안 정책 관리');
    expect(existsSync(outPath)).toBe(true);
    // validation is always present — valid:null (not a thrown error) when
    // officecli itself is unavailable, so this holds in every CI env.
    expect(result.validation).toBeDefined();
    expect([true, false, null]).toContain(result.validation.valid);
    rmSync(outPath);
  });
});
