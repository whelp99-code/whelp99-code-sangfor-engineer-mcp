/**
 * The honest-metric contract of @sangfor/competency.
 *
 * Kept from the pre-canonicalization suite: only automatable + field_verified
 * atoms count, human-only atoms never count however they are labelled, and
 * evidence must be a real confined artifact rather than prose. What changed is
 * the verdict for an unverifiable claim — it now refuses the report instead of
 * quietly dropping out of the numerator.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoverageContext,
  computeReplacementCoverage,
  loadWorkAtomCatalog,
  type CoverageContext,
} from '../packages/sangfor-competency/src/index.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });
const mkRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'competency-')); roots.push(d); return d; };

const EVIDENCE_FILE = 'diagnosis.md';

/** Every field_verified claim must bind to a capability the policy declares. */
const BOUND_REF = { product: 'EPP', capabilityId: 'cap.health' } as const;
const POLICY = [
  { product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' as const },
  { product: 'IAG', capabilityId: 'cap.policy', maturity: 'field_verified' as const },
];

const catalogOf = (atoms: readonly Record<string, unknown>[]): CoverageContext => {
  const catalogRoot = mkRoot();
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));
  const evidenceRoot = mkRoot();
  writeFileSync(join(evidenceRoot, EVIDENCE_FILE), '# real capture\n');
  return buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: POLICY,
  });
};

const FOUR_ATOMS: readonly Record<string, unknown>[] = [
  { id: 'a1', product: 'EPP', phase: 'operate', title: 'daily health', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: EVIDENCE_FILE, capabilityRef: BOUND_REF },
  { id: 'a2', product: 'EPP', phase: 'deploy', title: 'agent rollout', automatability: 'hybrid', coveredBy: 'sangfor_evaluate_config', maturity: 'tested_mock' },
  { id: 'a3', product: 'HCI', phase: 'deploy', title: 'rack & cable', automatability: 'human', humanReason: 'physical', maturity: 'planned' },
  { id: 'a4', product: 'IAG', phase: 'design', title: 'sizing', automatability: 'auto', coveredBy: null, maturity: 'planned' },
];

describe('sangfor-competency', () => {
  it('Given the seeded catalog under data/competency, When loaded, Then every atom carries its identifying fields', () => {
    const loaded = loadWorkAtomCatalog();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.atoms.length).toBeGreaterThan(0);
    expect(loaded.atoms.every((a) => a.id && a.product && a.phase && a.automatability)).toBe(true);
  });

  it('Given a mixed catalog, When coverage is computed, Then only field_verified + automatable atoms count', () => {
    const result = computeReplacementCoverage(catalogOf(FOUR_ATOMS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(1);   // a1 only
    expect(result.report.automatableAtoms).toBe(3); // a1, a2, a4
    expect(result.report.humanOnlyAtoms).toBe(1);   // a3
    expect(result.report.replacementRate).toBeCloseTo(1 / 3, 5);
  });

  it('Given a human-only atom marked covered and field_verified, When coverage is computed, Then it never counts toward replacement', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'x', product: 'HCI', phase: 'deploy', title: 'rack', automatability: 'human', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: EVIDENCE_FILE },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(0);
    expect(result.report.humanOnlyAtoms).toBe(1);
  });
});

describe('computeReplacementCoverage — red-team regressions', () => {
  it('Given a field_verified atom with no evidence, When coverage is computed, Then the report is refused rather than counting it', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'e1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', capabilityRef: BOUND_REF },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.kind)).toEqual(['evidenceNotRegularFile']);
  });

  it('Given a field_verified atom citing a real confined artifact, When coverage is computed, Then it counts once', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'e2', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: EVIDENCE_FILE, capabilityRef: BOUND_REF },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(1);
  });

  it('Given two atoms sharing an id, When the catalog loads, Then it is refused instead of silently deduplicated', () => {
    const loadedCtx = catalogOf([
      { id: 'd', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' },
      { id: 'd', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' },
    ]);
    const result = computeReplacementCoverage(loadedCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.kind)).toEqual(['duplicateId']);
  });
});

describe('computeReplacementCoverage — grounding against tools and evidence', () => {
  it('Given coveredBy naming an unregistered tool, When coverage is computed, Then the report is refused with unregisteredTool', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'o1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor_deleted_tool', maturity: 'field_verified', evidence: EVIDENCE_FILE, capabilityRef: BOUND_REF },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([expect.objectContaining({ kind: 'unregisteredTool', atomId: 'o1' })]);
  });

  it('Given prose used as evidence, When coverage is computed, Then the report is refused with evidenceNotRegularFile', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'deploy_asbuilt_doc', product: 'HCI', phase: 'handover', title: 'as-built', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: 'outputs/ (generated setting/operations guides)', capabilityRef: BOUND_REF },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.atomId)).toEqual(['deploy_asbuilt_doc']);
  });

  it('Given an absolute or traversing evidence path, When coverage is computed, Then the report is refused with evidenceOutsideRoot', () => {
    const result = computeReplacementCoverage(catalogOf([
      { id: 'abs', product: 'X', phase: 'operate', title: 'x', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: '/etc/hosts', capabilityRef: BOUND_REF },
      { id: 'trav', product: 'X', phase: 'operate', title: 'x', automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: '../../../../../../etc/hosts', capabilityRef: BOUND_REF },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.atomId).sort()).toEqual(['abs', 'trav']);
    expect([...new Set(result.violations.map((v) => v.kind))]).toEqual(['evidenceOutsideRoot']);
  });
});

describe('computeReplacementCoverage — maturity policy cross-check', () => {
  const policyAtom = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'cap-cross',
    product: 'IAG',
    phase: 'operate',
    title: 'policy-backed capability',
    automatability: 'auto',
    coveredBy: 'sangfor_evaluate_config',
    maturity: 'field_verified',
    evidence: EVIDENCE_FILE,
    capabilityRef: { product: 'IAG', capabilityId: 'cap.policy' },
    ...over,
  });

  const contextWithPolicy = (atoms: readonly Record<string, unknown>[], maturity: string): CoverageContext => {
    const catalogRoot = mkRoot();
    writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));
    const evidenceRoot = mkRoot();
    writeFileSync(join(evidenceRoot, EVIDENCE_FILE), '# real capture\n');
    return buildCoverageContext({
      catalogRoot,
      evidenceRoot,
      registeredTools: ['sangfor_evaluate_config'],
      maturityPolicy: [{ product: 'IAG', capabilityId: 'cap.policy', maturity: maturity as 'field_verified' }],
    });
  };

  it('Given policy maturity below the atom claim, When coverage is computed, Then the report is refused with maturityBelowClaim', () => {
    const result = computeReplacementCoverage(contextWithPolicy([policyAtom()], 'tested_mock'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([expect.objectContaining({ kind: 'maturityBelowClaim', atomId: 'cap-cross' })]);
  });

  it('Given policy maturity at or above the atom claim, When coverage is computed, Then the claim stands', () => {
    const result = computeReplacementCoverage(contextWithPolicy([policyAtom()], 'field_verified'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.replacedAtoms).toBe(1);
  });

  it('Given a capabilityRef absent from the policy, When coverage is computed, Then the report is refused rather than skipping the cross-check', () => {
    const result = computeReplacementCoverage(contextWithPolicy(
      [policyAtom({ capabilityRef: { product: 'IAG', capabilityId: 'cap.ghost' } })],
      'field_verified',
    ));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.kind)).toEqual(['missingCapabilityRef']);
  });

  it('Given an atom with no capabilityRef, When coverage is computed, Then the claim is refused because no policy can confirm it', () => {
    const result = computeReplacementCoverage(contextWithPolicy([policyAtom({ capabilityRef: undefined })], 'planned'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'missingCapabilityRef', atomId: 'cap-cross' }),
    ]);
  });
});
