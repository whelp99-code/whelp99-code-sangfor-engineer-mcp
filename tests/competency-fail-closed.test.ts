/**
 * Fail-closed WorkAtom loading + replacement coverage.
 *
 * Every malformed class must INVALIDATE the report with a typed violation.
 * Nothing may be silently skipped, and nothing may quietly shrink or grow the
 * denominator — a partially-loaded catalog that still prints a rate is exactly
 * the over-claim this package exists to prevent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoverageContext,
  computeReplacementCoverage,
  loadWorkAtomCatalog,
  type CoverageViolation,
} from '../packages/sangfor-competency/src/index.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });

const mkRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'competency-failclosed-'));
  roots.push(dir);
  return dir;
};

/** Every field_verified claim binds to a capability the default policy declares. */
const BOUND_REF = { product: 'EPP', capabilityId: 'cap.health' } as const;
const POLICY = [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' as const }];

const atom = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'op_daily_health',
  product: 'EPP',
  phase: 'operate',
  title: 'daily health',
  automatability: 'auto',
  coveredBy: 'sangfor_evaluate_config',
  maturity: 'field_verified',
  evidence: 'artifact.md',
  capabilityRef: BOUND_REF,
  ...over,
});

const writeCatalog = (root: string, atoms: readonly unknown[], file = 'work-atoms.json'): void => {
  writeFileSync(join(root, file), JSON.stringify({ version: 1, atoms }));
};

/** A grounded context: one registered tool, an evidence root holding one real artifact file. */
const groundedContext = (catalogRoot: string, over: Partial<Parameters<typeof buildCoverageContext>[0]> = {}) => {
  const evidenceRoot = mkRoot();
  writeFileSync(join(evidenceRoot, 'artifact.md'), '# real artifact\n');
  mkdirSync(join(evidenceRoot, 'outputs'), { recursive: true });
  return buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: POLICY,
    ...over,
  });
};

const kinds = (violations: readonly CoverageViolation[]): readonly string[] =>
  [...new Set(violations.map((v) => v.kind))].sort();

describe('buildCoverageContext — grounding is mandatory, not optional', () => {
  it('Given a context request with no registered tools, When built, Then it throws instead of grounding coverage on nothing', () => {
    const root = mkRoot();
    writeCatalog(root, [atom()]);
    expect(() => buildCoverageContext({
      catalogRoot: root,
      evidenceRoot: root,
      registeredTools: [],
      maturityPolicy: POLICY,
    })).toThrow(/registeredTools/u);
  });

  it('Given a context request whose evidence root does not exist, When built, Then it throws instead of silently failing every evidence check', () => {
    const root = mkRoot();
    expect(() => buildCoverageContext({
      catalogRoot: root,
      evidenceRoot: join(root, 'no-such-dir'),
      registeredTools: ['sangfor_evaluate_config'],
      maturityPolicy: POLICY,
    })).toThrow(/evidenceRoot/u);
  });
});

describe('loadWorkAtomCatalog — malformed input invalidates the catalog', () => {
  it('Given an unparseable atom file, When the catalog loads, Then it fails with a corruptFile violation and no atoms', () => {
    const root = mkRoot();
    writeCatalog(root, [atom()]);
    writeFileSync(join(root, 'broken.json'), 'NOT JSON AT ALL');

    const loaded = loadWorkAtomCatalog(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(kinds(loaded.violations)).toEqual(['corruptFile']);
    expect(loaded.violations[0]?.detail).toContain('broken.json');
  });

  it('Given an atom violating the schema, When the catalog loads, Then it fails with a schemaInvalid violation', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ automatability: 'sometimes' })]);

    const loaded = loadWorkAtomCatalog(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(kinds(loaded.violations)).toEqual(['schemaInvalid']);
  });

  it('Given two atoms whose ids differ only by case and surrounding space, When the catalog loads, Then it fails with duplicateId rather than silently deduplicating', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ id: 'op_daily_health' }), atom({ id: '  OP_Daily_Health ' })]);

    const loaded = loadWorkAtomCatalog(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(kinds(loaded.violations)).toEqual(['duplicateId']);
    expect(loaded.violations[0]?.detail).toContain('op_daily_health');
  });

  it('Given a well-formed catalog, When it loads, Then it yields exactly the declared atoms', () => {
    const root = mkRoot();
    writeCatalog(root, [atom(), atom({ id: 'rack_cable', automatability: 'human', humanReason: 'physical', maturity: 'planned', coveredBy: null, evidence: null, capabilityRef: undefined })]);

    const loaded = loadWorkAtomCatalog(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.atoms.map((a) => a.id)).toEqual(['op_daily_health', 'rack_cable']);
  });

  it('Given a missing catalog root, When it loads, Then it fails with a missingCatalog violation instead of an empty success', () => {
    const root = mkRoot();
    const loaded = loadWorkAtomCatalog(join(root, 'absent'));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(kinds(loaded.violations)).toEqual(['missingCatalog']);
  });
});

describe('computeReplacementCoverage — grounding failures invalidate the report', () => {
  it('Given an atom covered by an unregistered tool, When coverage is computed, Then the report is invalid with unregisteredTool and carries no metric', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ coveredBy: 'sangfor_deleted_tool' })]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['unregisteredTool']);
    expect(result).not.toHaveProperty('report');
  });

  it('Given evidence pointing at a directory, When coverage is computed, Then the report is invalid with evidenceNotRegularFile', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ evidence: 'outputs' })]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['evidenceNotRegularFile']);
  });

  it('Given evidence escaping the confined root, When coverage is computed, Then the report is invalid with evidenceOutsideRoot', () => {
    const root = mkRoot();
    writeCatalog(root, [
      atom({ id: 'abs_evidence', evidence: '/etc/hosts' }),
      atom({ id: 'trav_evidence', evidence: '../../../../etc/hosts' }),
    ]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['evidenceOutsideRoot']);
    expect(result.violations).toHaveLength(2);
  });

  it('Given a field_verified atom with no capabilityRef at all, When coverage is computed, Then it cannot promote', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ capabilityRef: undefined })]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['missingCapabilityRef']);
  });

  it('Given a capabilityRef absent from the maturity policy, When coverage is computed, Then the report is invalid with missingCapabilityRef', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ capabilityRef: { product: 'EPP', capabilityId: 'cap.ghost' } })]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['missingCapabilityRef']);
  });

  it('Given a field_verified atom whose policy maturity is lower, When coverage is computed, Then the report is invalid with maturityBelowClaim', () => {
    const root = mkRoot();
    writeCatalog(root, [atom()]);

    const result = computeReplacementCoverage(groundedContext(root, {
      maturityPolicy: [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'tested_mock' }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['maturityBelowClaim']);
  });

  it('Given every malformed class at once, When coverage is computed, Then all violations are reported together, not just the first', () => {
    const root = mkRoot();
    writeCatalog(root, [
      atom({ id: 'bad_tool', coveredBy: 'sangfor_deleted_tool' }),
      atom({ id: 'bad_evidence', evidence: 'outputs' }),
      atom({ id: 'bad_ref', capabilityRef: { product: 'EPP', capabilityId: 'cap.ghost' } }),
    ]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.violations)).toEqual(['evidenceNotRegularFile', 'missingCapabilityRef', 'unregisteredTool']);
  });
});

describe('computeReplacementCoverage — a clean catalog yields one grounded report', () => {
  it('Given a clean catalog, When coverage is computed, Then the metric counts only automatable + field_verified + grounded atoms', () => {
    const root = mkRoot();
    writeCatalog(root, [
      atom({ id: 'op_daily_health' }),
      atom({ id: 'agent_rollout', automatability: 'hybrid', maturity: 'tested_mock', evidence: null, capabilityRef: undefined }),
      atom({ id: 'rack_cable', automatability: 'human', humanReason: 'physical', maturity: 'planned', coveredBy: null, evidence: null, capabilityRef: undefined }),
    ]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.totalAtoms).toBe(3);
    expect(result.report.automatableAtoms).toBe(2);
    expect(result.report.humanOnlyAtoms).toBe(1);
    expect(result.report.replacedAtoms).toBe(1);
    expect(result.report.replacementRate).toBeCloseTo(0.5, 5);
  });

  it('Given a human-only atom mislabelled as covered and field_verified, When coverage is computed, Then it never counts toward replacement', () => {
    const root = mkRoot();
    writeCatalog(root, [atom({ id: 'rack_cable', automatability: 'human', humanReason: 'physical', capabilityRef: undefined })]);

    const result = computeReplacementCoverage(groundedContext(root));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(0);
    expect(result.report.humanOnlyAtoms).toBe(1);
    expect(result.report.automatableAtoms).toBe(0);
    expect(result.report.replacementRate).toBe(0);
  });

  it('Given the committed curated catalog and its real grounding, When coverage is computed, Then both call sites can only produce the one grounded 16-atom denominator', () => {
    const result = computeReplacementCoverage(buildCoverageContext({
      catalogRoot: join(import.meta.dirname, '..', 'data', 'competency'),
      evidenceRoot: join(import.meta.dirname, '..'),
      registeredTools: ['sangfor_evaluate_config', 'sangfor_generate_comprehensive_operations_guide_docx'],
      maturityPolicy: POLICY,
    }));

    // deploy_asbuilt_doc cites a prose/dir evidence string → the whole report is
    // invalid. There is no "2 of 16" surface left to disagree with "1 of 16".
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.atomId)).toContain('deploy_asbuilt_doc');
  });
});
