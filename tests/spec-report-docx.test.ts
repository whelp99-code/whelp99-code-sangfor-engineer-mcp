import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSpec, evaluateSpec, renderAdvisoryReportDocx } from '../packages/sangfor-spec/src/index.js';

const spec = loadSpec('IAG', '13.0.120')!;
const result = evaluateSpec(spec, { securityEventsCount: 0, haEnabled: false });
const ROOT = join(tmpdir(), `advroot-${Date.now()}`);

const TEMP_PREFIX = 'advdocx-';

/** The scratch roots the renderer creates in the system temp dir. */
function tempRoots(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)).sort();
}

/** Run `action`, and return the scratch roots it left behind. */
function residueOf(action: () => void): { thrown: unknown; residue: string[] } {
  const before = new Set(tempRoots());
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  return { thrown, residue: tempRoots().filter((name) => !before.has(name)) };
}

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

  describe('temp scratch hygiene', () => {
    it('Given a traversal outputPath, When refused, Then the exact error is raised and no scratch root is left', () => {
      // Given / When
      const { thrown, residue } = residueOf(() => renderAdvisoryReportDocx(spec, result, '../../etc/evil.docx'));

      // Then
      expect((thrown as Error | undefined)?.message)
        .toBe('docx outputPath escapes the output root: ../../etc/evil.docx');
      expect(residue).toEqual([]);
    });

    it('Given a non-.docx outputPath, When refused, Then the exact error is raised and no scratch root is left', () => {
      // Given / When
      const { thrown, residue } = residueOf(() => renderAdvisoryReportDocx(spec, result, join(ROOT, 'refused.txt')));

      // Then
      expect((thrown as Error | undefined)?.message).toBe('docx outputPath must end with .docx');
      expect(residue).toEqual([]);
    });

    it('Given an unusable destination directory, When the write fails, Then no scratch root is left', () => {
      // Given: a regular file where the renderer would need a parent directory
      mkdirSync(ROOT, { recursive: true });
      const blocker = join(ROOT, 'blocker');
      writeFileSync(blocker, 'not a directory');

      // When
      const { thrown, residue } = residueOf(() => renderAdvisoryReportDocx(spec, result, join(blocker, 'out.docx')));

      // Then
      expect(thrown).toBeInstanceOf(Error);
      expect(residue).toEqual([]);
    });

    it('Given an existing directory at the output path, When zipping fails, Then no scratch root is left', () => {
      // Given: the archive target is a directory, so the zip step cannot write it
      const occupied = join(ROOT, 'occupied.docx');
      mkdirSync(occupied, { recursive: true });

      // When
      const { thrown, residue } = residueOf(() => renderAdvisoryReportDocx(spec, result, occupied));

      // Then
      expect(thrown).toBeInstanceOf(Error);
      expect(residue).toEqual([]);
    });

    it('Given a valid outputPath, When the docx is written, Then no scratch root is left', () => {
      // Given / When
      const out = join(ROOT, 'clean.docx');
      const { thrown, residue } = residueOf(() => renderAdvisoryReportDocx(spec, result, out));

      // Then
      expect(thrown).toBeUndefined();
      expect(residue).toEqual([]);
      expect(statSync(out).size).toBeGreaterThan(0);
    });
  });
});
