import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCaptureFilePath,
  buildCaptureRelativeDir,
  resolveConfinedOutputDir,
} from '../packages/sangfor-screenshot/src/console-evidence-paths.js';

/**
 * Console evidence must be separable by CUSTOMER, DEVICE, and DATE.
 *
 * Customer already comes from the engagement-scoped evidence root and date is
 * already both a folder and a filename token. Device was the missing dimension:
 * two IAG appliances in one engagement were indistinguishable, so their captures
 * landed in the same directory with colliding names.
 *
 * Backward compatibility is a hard requirement — captures already on disk must
 * stay findable, so omitting the device must reproduce today's exact path.
 */

let root: string;
let saved: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evidence-device-'));
  saved = process.env.SANGFOR_EVIDENCE_ROOT;
  process.env.SANGFOR_EVIDENCE_ROOT = root;
});

afterEach(() => {
  if (saved === undefined) delete process.env.SANGFOR_EVIDENCE_ROOT;
  else process.env.SANGFOR_EVIDENCE_ROOT = saved;
  rmSync(root, { recursive: true, force: true });
});

describe('capture filename carries the device', () => {
  it('includes the device token next to the product', () => {
    const path = buildCaptureFilePath('/out', '03', 'IAG', 'ActivityAudit', '20260812', 'iag-hq-01');
    expect(path).toContain('REQ03_IAG_iag-hq-01_ActivityAudit_Before_20260812.png');
  });

  it('stays byte-identical to today when no device is supplied', () => {
    const legacy = buildCaptureFilePath('/out', '03', 'IAG', 'ActivityAudit', '20260812');
    expect(legacy).toBe(join('/out', 'REQ03_IAG_ActivityAudit_Before_20260812.png'));
  });

  it('treats a blank device as absent rather than inventing a name', () => {
    for (const blank of ['', '   ', undefined]) {
      const path = buildCaptureFilePath('/out', '03', 'IAG', 'Audit', '20260812', blank);
      expect(path).toBe(join('/out', 'REQ03_IAG_Audit_Before_20260812.png'));
      expect(path).not.toContain('unnamed');
    }
  });

  it('normalises a hostile device value into one safe filename token', () => {
    const path = buildCaptureFilePath('/out', '03', 'IAG', 'Audit', '20260812', '../../etc/passwd');
    expect(path).toBe(join('/out', 'REQ03_IAG_etc_passwd_Audit_Before_20260812.png'));
    expect(path).not.toContain('..');
  });
});

describe('capture directory separates devices', () => {
  it('nests the device under the date folder', () => {
    expect(buildCaptureRelativeDir('20260812', 'iag-hq-01')).toBe(join('captures', '20260812', 'iag-hq-01'));
  });

  it('omits the device segment when none is supplied, preserving the legacy path', () => {
    expect(buildCaptureRelativeDir('20260812')).toBe(join('captures', '20260812'));
    expect(buildCaptureRelativeDir('20260812', '  ')).toBe(join('captures', '20260812'));
  });

  it('gives two devices in the same engagement and date different directories', () => {
    const a = buildCaptureRelativeDir('20260812', 'iag-hq-01');
    const b = buildCaptureRelativeDir('20260812', 'iag-dr-02');
    expect(a).not.toBe(b);
  });

  it('keeps a hostile device inside the confined evidence root', () => {
    const escaped = buildCaptureRelativeDir('20260812', '../../../../tmp/pwned');
    const resolved = resolveConfinedOutputDir(escaped);
    expect(resolved.startsWith(root)).toBe(true);
    expect(resolved).not.toContain(`..${sep}`);
  });

  it('still refuses a directory that genuinely escapes the root', () => {
    expect(() => resolveConfinedOutputDir('../../../../tmp/pwned')).toThrow(/CAPTURE_DIR_OUTSIDE_ROOT/);
  });

  it('resolves both device directories inside the root and distinct on disk', () => {
    const a = resolveConfinedOutputDir(buildCaptureRelativeDir('20260812', 'iag-hq-01'));
    const b = resolveConfinedOutputDir(buildCaptureRelativeDir('20260812', 'iag-dr-02'));
    expect(a).not.toBe(b);
    for (const dir of [a, b]) expect(dir.startsWith(root)).toBe(true);
  });
});
