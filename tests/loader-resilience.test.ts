import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';
import { loadWorkAtomCatalog } from '../packages/sangfor-competency/src/index.js';
import { recommendSizing } from '../packages/sangfor-sizing/src/index.js';
import { getCapabilitySafety } from '../packages/sangfor-safety/src/index.js';
import { loadAuditFrameworks } from '../packages/sangfor-audit/src/index.js';

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

// Unlike the spec/safety/audit loaders above, the competency catalog is a
// DENOMINATOR: a partially-loaded catalog still produces a confident
// percentage, so skipping the corrupt file would silently over-claim the
// replacement rate. It therefore refuses the whole load instead of degrading.
describe('loadWorkAtomCatalog — one corrupt atom file invalidates the whole catalog', () => {
  it('does not throw, and returns a typed corruptFile violation instead of a partial atom list', () => {
    const root = mk();
    writeFileSync(join(root, 'good.json'), JSON.stringify({
      atoms: [{ id: 'a1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' }],
    }));
    writeFileSync(join(root, 'bad.json'), 'NOT JSON AT ALL');

    let loaded: ReturnType<typeof loadWorkAtomCatalog> | undefined;
    expect(() => { loaded = loadWorkAtomCatalog(root); }).not.toThrow();
    expect(loaded?.ok).toBe(false);
    if (!loaded || loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['corruptFile']);
    expect(loaded).not.toHaveProperty('atoms');
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

describe('loadAuditFrameworks — one corrupt/invalid framework file must not crash the whole load', () => {
  const validItem = {
    itemId: 'ITEM-01',
    topic: 'x',
    reqIds: ['REQ-1'],
    group: 'G1',
    groupLabel: 'group',
    products: ['IAG'],
    method: 'console_dryrun',
    requiredEvidence: ['evidence'],
    owner: 'engineer',
    priority: 'P1',
  };
  const validFramework = { frameworkId: 'good-fw', title: 't', version: '1', sourceNote: 'n', items: [validItem] };

  it('skips an unparseable JSON file and still loads the valid ones', () => {
    const root = mk();
    writeFileSync(join(root, 'good.json'), JSON.stringify(validFramework));
    writeFileSync(join(root, 'bad.json'), 'NOT JSON AT ALL');

    let frameworks: ReturnType<typeof loadAuditFrameworks> = [];
    expect(() => { frameworks = loadAuditFrameworks(root); }).not.toThrow();
    expect(frameworks.map((f) => f.frameworkId)).toEqual(['good-fw']);
  });

  it('rejects (skips) a framework file whose items violate the schema, without crashing the load', () => {
    const root = mk();
    writeFileSync(join(root, 'good.json'), JSON.stringify(validFramework));
    writeFileSync(join(root, 'invalid-schema.json'), JSON.stringify({
      ...validFramework,
      frameworkId: 'bad-fw',
      items: [{ ...validItem, priority: 'NOT_A_PRIORITY' }],
    }));

    let frameworks: ReturnType<typeof loadAuditFrameworks> = [];
    expect(() => { frameworks = loadAuditFrameworks(root); }).not.toThrow();
    expect(frameworks.map((f) => f.frameworkId)).toEqual(['good-fw']);
  });
});
