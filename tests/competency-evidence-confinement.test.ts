/**
 * Blocker 1 — evidence confinement must survive symlinks.
 *
 * Lexical `resolve()` + `startsWith(root)` only proves the *spelling* of a path
 * stays inside the root. A symlink whose target sits outside the root spells
 * fine and still promotes an atom on evidence the root does not contain, which
 * is the same over-claim as citing /etc/hosts directly. Confinement is therefore
 * decided on the real path, and a symlink is refused outright.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoverageContext, computeReplacementCoverage } from '../packages/sangfor-competency/src/index.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });
const mkRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'competency-symlink-')); roots.push(d); return d; };

const POLICY = [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' as const }];

const claim = (evidence: string): Record<string, unknown> => ({
  id: 'symlinked_claim',
  product: 'EPP',
  phase: 'operate',
  title: 'daily health',
  automatability: 'auto',
  coveredBy: 'sangfor_evaluate_config',
  maturity: 'field_verified',
  evidence,
  capabilityRef: { product: 'EPP', capabilityId: 'cap.health' },
});

/** Builds a catalog + evidence root pair and returns the computed result. */
const runWith = (evidence: string, wire: (evidenceRoot: string, outsideRoot: string) => void) => {
  const catalogRoot = mkRoot();
  const evidenceRoot = mkRoot();
  const outsideRoot = mkRoot();
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: [claim(evidence)] }));
  wire(evidenceRoot, outsideRoot);
  return computeReplacementCoverage(buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: POLICY,
  }));
};

describe('evidence confinement — symlinks cannot smuggle an outside artifact into the root', () => {
  it('Given evidence is a symlink to a real file OUTSIDE the root, When coverage is computed, Then the claim is refused as outside-root', () => {
    const result = runWith('escape.md', (evidenceRoot, outsideRoot) => {
      const secret = join(outsideRoot, 'secret.md');
      writeFileSync(secret, '# artifact the evidence root does not contain\n');
      symlinkSync(secret, join(evidenceRoot, 'escape.md'));
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'evidenceOutsideRoot', atomId: 'symlinked_claim' }),
    ]);
  });

  it('Given evidence sits under a symlinked DIRECTORY escaping the root, When coverage is computed, Then the claim is refused as outside-root', () => {
    const result = runWith('linked/report.md', (evidenceRoot, outsideRoot) => {
      const realDir = join(outsideRoot, 'real');
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, 'report.md'), '# outside the root\n');
      symlinkSync(realDir, join(evidenceRoot, 'linked'));
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'evidenceOutsideRoot', atomId: 'symlinked_claim' }),
    ]);
  });

  it('Given evidence is a symlink to a file INSIDE the root, When coverage is computed, Then it is still refused because a symlink is not a regular artifact', () => {
    const result = runWith('alias.md', (evidenceRoot) => {
      const real = join(evidenceRoot, 'real.md');
      writeFileSync(real, '# genuinely inside\n');
      symlinkSync(real, join(evidenceRoot, 'alias.md'));
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'evidenceNotRegularFile', atomId: 'symlinked_claim' }),
    ]);
  });

  it('Given evidence is a dangling symlink, When coverage is computed, Then it is refused rather than throwing', () => {
    let result: ReturnType<typeof runWith> | undefined;
    expect(() => {
      result = runWith('dangling.md', (evidenceRoot) => {
        symlinkSync(join(evidenceRoot, 'nope.md'), join(evidenceRoot, 'dangling.md'));
      });
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.violations.map((v) => v.atomId)).toEqual(['symlinked_claim']);
  });

  it('Given evidence is a genuine regular file inside the root, When coverage is computed, Then the claim still counts', () => {
    const result = runWith('capture.md', (evidenceRoot) => {
      writeFileSync(join(evidenceRoot, 'capture.md'), '# real capture\n');
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(1);
  });
});
