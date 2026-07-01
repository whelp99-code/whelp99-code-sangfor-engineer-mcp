import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSpec, evaluateSpec, renderAdvisoryReportDocx } from '../packages/sangfor-spec/src/index.js';

const spec = loadSpec('IAG', '13.0.120')!;
const result = evaluateSpec(spec, { securityEventsCount: 0, haEnabled: false });
const ROOT = join(tmpdir(), `advroot-${Date.now()}`);

beforeAll(() => { process.env.SANGFOR_OUTPUT_ROOT = ROOT; });

describe('renderAdvisoryReportDocx', () => {
  it('produces a non-empty .docx file', () => {
    const out = join(ROOT, 'adv.docx');
    const r = renderAdvisoryReportDocx(spec, result, out);
    expect(r.docxPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it('is a valid docx (zip) whose document.xml carries the Korean section headings', () => {
    const out = join(ROOT, 'adv2.docx');
    renderAdvisoryReportDocx(spec, result, out);
    const doc = execFileSync('unzip', ['-p', out, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 10_000_000 });
    expect(doc).toContain('잘못된 설정');
    expect(doc).toContain('추가');
    expect(doc).toContain('면책');
    expect(doc).not.toContain('**'); // bold markers stripped (incl. blockquote)
  });

  it('rejects a path-traversal outputPath (no arbitrary file overwrite)', () => {
    expect(() => renderAdvisoryReportDocx(spec, result, '../../etc/evil.docx')).toThrow(/escape/i);
  });

  it('rejects a non-.docx outputPath', () => {
    expect(() => renderAdvisoryReportDocx(spec, result, join(ROOT, 'x.txt'))).toThrow(/docx/i);
  });
});
