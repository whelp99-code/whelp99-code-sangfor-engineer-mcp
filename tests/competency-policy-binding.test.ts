/**
 * Blockers 4 + 5 — a replacement claim must bind to a real policy capability,
 * and every catalog/policy wrapper is closed to unknown keys.
 *
 * "field_verified with no capabilityRef" used to be the easiest promotion in the
 * system: it skipped the maturity cross-check entirely, so an atom could claim
 * the strongest maturity while naming nothing the policy could contradict. A
 * claim that binds to nothing is unverifiable, not exempt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoverageContext,
  computeReplacementCoverage,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
} from '../packages/sangfor-competency/src/index.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });
const mkRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'competency-policy-')); roots.push(d); return d; };

const POLICY = [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' as const }];

const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'bound_claim',
  product: 'EPP',
  phase: 'operate',
  title: 'daily health',
  automatability: 'auto',
  coveredBy: 'sangfor_evaluate_config',
  maturity: 'field_verified',
  evidence: 'capture.md',
  capabilityRef: { product: 'EPP', capabilityId: 'cap.health' },
  ...over,
});

const runCatalog = (atoms: readonly unknown[], policy: readonly { product: string; capabilityId: string; maturity: 'field_verified' }[] = POLICY) => {
  const catalogRoot = mkRoot();
  const evidenceRoot = mkRoot();
  writeFileSync(join(evidenceRoot, 'capture.md'), '# real capture\n');
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));
  return computeReplacementCoverage(buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: policy,
  }));
};

describe('field-verified claims must bind to a policy capability', () => {
  it('Given a field_verified atom with NO capabilityRef, When coverage is computed, Then it cannot promote and is refused', () => {
    const result = runCatalog([claim({ capabilityRef: undefined })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'missingCapabilityRef', atomId: 'bound_claim' }),
    ]);
  });

  it('Given a field_verified atom bound to a capability the policy does not declare, When coverage is computed, Then it is refused', () => {
    const result = runCatalog([claim({ capabilityRef: { product: 'EPP', capabilityId: 'cap.ghost' } })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'missingCapabilityRef', atomId: 'bound_claim' }),
    ]);
  });

  it('Given a NON-field_verified atom with no capabilityRef, When coverage is computed, Then it is not a claim and needs no binding', () => {
    const result = runCatalog([claim({ maturity: 'tested_mock', capabilityRef: undefined, evidence: null })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.automatableAtoms).toBe(1);
    expect(result.report.replacedAtoms).toBe(0);
  });

  it('Given a properly bound field_verified atom, When coverage is computed, Then it counts', () => {
    const result = runCatalog([claim()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(1);
  });
});

describe('the maturity policy itself is loaded fail-closed', () => {
  const writePolicy = (body: string): string => {
    const dir = mkRoot();
    writeFileSync(join(dir, 'capability-maturity.json'), body);
    return dir;
  };

  it('Given the curated policy file, When loaded strictly, Then it parses including its evidence citations', () => {
    const loaded = loadMaturityPolicyStrict(join(import.meta.dirname, '..', 'data', 'competency'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.entries.length).toBeGreaterThan(0);
    expect(loaded.entries.every((e) => e.product && e.capabilityId && e.maturity)).toBe(true);
  });

  it('Given a corrupt policy file, When loaded strictly, Then it refuses instead of degrading to zero entries', () => {
    const loaded = loadMaturityPolicyStrict(writePolicy('{ not json'));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['corruptFile']);
  });

  it('Given a missing policy file, When loaded strictly, Then it refuses instead of returning an empty policy', () => {
    const loaded = loadMaturityPolicyStrict(mkRoot());
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['missingCatalog']);
  });

  it('Given the policy declares one capability twice, When loaded strictly, Then it refuses as duplicate', () => {
    const loaded = loadMaturityPolicyStrict(writePolicy(JSON.stringify({
      version: 1,
      entries: [
        { product: 'EPP', capabilityId: 'cap.health', maturity: 'tested_mock' },
        { product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' },
      ],
    })));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['duplicateId']);
  });

  it('Given a duplicated capability, When a context is built from it, Then construction fails rather than picking a winner', () => {
    expect(() => buildCoverageContext({
      catalogRoot: mkRoot(),
      evidenceRoot: mkRoot(),
      registeredTools: ['sangfor_evaluate_config'],
      maturityPolicy: [
        { product: 'EPP', capabilityId: 'cap.health', maturity: 'tested_mock' },
        { product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' },
      ],
    })).toThrow(/maturityPolicy/u);
  });
});

describe('catalog and policy wrappers are closed to unknown keys', () => {
  it('Given a catalog wrapper carrying an unknown key, When the catalog loads, Then it is refused as schema-invalid', () => {
    const root = mkRoot();
    writeFileSync(join(root, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: [], generatedBy: 'somebody' }));
    const loaded = loadWorkAtomCatalog(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['schemaInvalid']);
  });

  it('Given a policy entry carrying an unknown key, When loaded strictly, Then it is refused as schema-invalid', () => {
    const dir = mkRoot();
    writeFileSync(join(dir, 'capability-maturity.json'), JSON.stringify({
      version: 1,
      entries: [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified', promotedBy: 'me' }],
    }));
    const loaded = loadMaturityPolicyStrict(dir);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['schemaInvalid']);
  });
});
