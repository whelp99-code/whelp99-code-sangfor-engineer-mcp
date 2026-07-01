import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';
import { loadWorkAtoms } from '../packages/sangfor-competency/src/index.js';
import { recommendSizing } from '../packages/sangfor-sizing/src/index.js';
import { getCapabilitySafety } from '../packages/sangfor-safety/src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'sangfor-loader-')); dirs.push(d); return d; };

describe('loadSpec — one corrupt spec file must not crash the whole product load', () => {
  it('loads the valid file and surfaces the corrupt file as an INDETERMINATE sentinel (not silent drop / crash)', () => {
    const root = mk();
    const vdir = join(root, 'IAG', '13.0.120');
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'good.json'), JSON.stringify({
      product: 'IAG',
      items: [{ id: 'ok1', capabilityId: 'c', label: 'ok item', observedKey: 'k', op: 'exists', severity: 'recommended' }],
    }));
    writeFileSync(join(vdir, 'bad.json'), '{ this is not valid json ');

    const spec = loadSpec('IAG', '13.0.120', root);
    expect(spec).not.toBeNull();
    // valid item preserved
    expect(spec!.items.some((i) => i.id === 'ok1')).toBe(true);
    // corruption surfaced as a MUST-without-source sentinel → evaluates to INDETERMINATE
    const sentinel = spec!.items.find((i) => /파싱 실패|unparseable/i.test(i.label));
    expect(sentinel).toBeTruthy();
    expect(sentinel!.severity).toBe('must');
    expect(sentinel!.source).toBeUndefined();
  });
});

describe('loadWorkAtoms — one corrupt atom file is skipped, the rest still load', () => {
  it('does not throw and returns atoms from the valid files', () => {
    const root = mk();
    writeFileSync(join(root, 'good.json'), JSON.stringify({
      atoms: [{ id: 'a1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' }],
    }));
    writeFileSync(join(root, 'bad.json'), 'NOT JSON AT ALL');

    let atoms: ReturnType<typeof loadWorkAtoms> = [];
    expect(() => { atoms = loadWorkAtoms(root); }).not.toThrow();
    expect(atoms.some((a) => a.id === 'a1')).toBe(true);
  });
});

describe('recommendSizing — corrupt thresholds.json degrades to unsourced (판정불가), not a crash', () => {
  it('does not throw and returns tier "unsourced"', () => {
    const root = mk();
    writeFileSync(join(root, 'thresholds.json'), '{ corrupt json');
    let r: ReturnType<typeof recommendSizing>;
    expect(() => { r = recommendSizing('IAG', { concurrentUsers: 8000 }, root); }).not.toThrow();
    expect(r!.tier).toBe('unsourced');
    expect(r!.tierSource).toBeNull();
  });
});

describe('listSpecCoverage — a dangling symlink in the spec root must not crash the scan', () => {
  it('skips the dangling entry and returns without throwing', () => {
    const root = mk();
    const good = join(root, 'IAG', '13.0.120');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, 's.json'), JSON.stringify({ product: 'IAG', items: [{ id: 'i', capabilityId: 'c', label: 'l', observedKey: 'k', op: 'exists', severity: 'recommended' }] }));
    symlinkSync(join(root, 'does-not-exist'), join(root, 'DANGLING')); // statSync would ENOENT
    let cov: ReturnType<typeof listSpecCoverage> = [];
    expect(() => { cov = listSpecCoverage(root); }).not.toThrow();
    expect(cov.some((c) => c.product === 'IAG')).toBe(true);
  });
});

describe('getCapabilitySafety — corrupt safety policy degrades to human_only deny, not a crash', () => {
  it('does not throw and defaults to the safe deny class', () => {
    const root = mk();
    mkdirSync(join(root, 'safety'), { recursive: true });
    writeFileSync(join(root, 'safety', 'capability-safety.json'), 'NOT JSON');
    let s: ReturnType<typeof getCapabilitySafety>;
    expect(() => { s = getCapabilitySafety('HCI', 'anything', root); }).not.toThrow();
    expect(s!.safetyClass).toBe('human_only');
    expect(s!.autoAllowed).toBe(false);
  });
});
