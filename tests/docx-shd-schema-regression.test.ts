import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOperationsGuideDocx } from '../packages/sangfor-product-adapters/src/docx-builder.js';
import { isOfficeCliAvailable } from '../packages/sangfor-office/src/index.js';

// Regression test for card O2(a): docx-builder.ts's table() helper used to
// emit <w:shd w:fill="..."/> without the required w:val attribute, which
// officecli validate flagged as 15 of 19 total schema errors ("required
// attribute 'val' is missing") on buildOperationsGuideDocx's output. The fix
// adds w:val="clear" (OpenXML's "solid fill, no pattern" value) alongside
// w:color="auto". This test asserts the fixed generator never regresses to
// an unqualified w:shd again, by inspecting the raw document.xml — which
// works with or without officecli installed — and, when officecli IS
// installed, cross-checks against the real schema-error count officecli
// reports (should now be 4: the still-open w:tblLayout ordering issue,
// unrelated to this fix and intentionally left unfixed per the master's
// "report but don't guess-fix" instruction).

describe('docx-builder.ts table shd — w:val regression (raw XML, no officecli required)', () => {
  let outPath: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sangfor-docx-shd-'));
    outPath = join(workDir, 'ops-guide.docx');
    await buildOperationsGuideDocx({ outputPath: outPath });
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('generated docx exists', () => {
    expect(existsSync(outPath)).toBe(true);
  });

  it('every w:shd element in document.xml carries w:val', () => {
    const xml = execFileSync('unzip', ['-p', outPath, 'word/document.xml'], { encoding: 'utf8' });
    const shdTags = xml.match(/<w:shd\b[^>]*\/>/g) ?? [];
    expect(shdTags.length).toBeGreaterThan(0); // sanity: the fixture still has header-row shading
    const withoutVal = shdTags.filter((tag) => !/w:val=/.test(tag));
    expect(withoutVal).toEqual([]);
  });

  it.skipIf(!isOfficeCliAvailable().available)(
    'officecli validate reports zero errors (was 19: w:shd missing val, then 4: w:tblLayout ordering) — skipped: officecli not installed on this host',
    async () => {
      const { validateOfficeDocument } = await import('../packages/sangfor-office/src/index.js');
      const result = await validateOfficeDocument(outPath);
      expect(result.errors).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.valid).toBe(true);
    },
  );

  it('tblPr keeps the CT_TblPrBase order: tblLayout before tblCellMar', () => {
    const xml = execFileSync('unzip', ['-p', outPath, 'word/document.xml'], { encoding: 'utf8' });
    const tblPrBlocks = xml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g) ?? [];
    expect(tblPrBlocks.length).toBeGreaterThan(0);
    for (const block of tblPrBlocks) {
      const layoutAt = block.indexOf('<w:tblLayout');
      const cellMarAt = block.indexOf('<w:tblCellMar');
      if (layoutAt >= 0 && cellMarAt >= 0) expect(layoutAt).toBeLessThan(cellMarAt);
    }
  });
});
