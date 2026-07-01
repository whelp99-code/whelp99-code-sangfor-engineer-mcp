import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../packages/sangfor-spec/src/index.js';
import { loadWorkAtoms } from '../packages/sangfor-competency/src/index.js';

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
