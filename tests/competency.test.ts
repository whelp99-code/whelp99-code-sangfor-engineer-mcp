import { describe, expect, it } from 'vitest';
import { loadWorkAtoms, computeReplacementCoverage, type WorkAtom } from '../packages/sangfor-competency/src/index.js';

const atoms: WorkAtom[] = [
  { id: 'a1', product: 'EPP', phase: 'operate', title: 'daily health', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: 'outputs/diagnosis/EPP_6.0.4_live_diagnosis.md' },
  { id: 'a2', product: 'EPP', phase: 'deploy', title: 'agent rollout', automatability: 'hybrid', coveredBy: 'sangfor.evaluate_config', maturity: 'tested_mock' },
  { id: 'a3', product: 'HCI', phase: 'deploy', title: 'rack & cable', automatability: 'human', humanReason: 'physical', maturity: 'planned' },
  { id: 'a4', product: 'IAG', phase: 'design', title: 'sizing', automatability: 'auto', coveredBy: null as any, maturity: 'planned' },
];

describe('sangfor-competency', () => {
  it('loads the seeded WorkAtom catalog from data/competency', () => {
    const loaded = loadWorkAtoms();
    expect(Array.isArray(loaded)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((a) => a.id && a.product && a.phase && a.automatability)).toBe(true);
  });

  it('replacement rate counts ONLY field_verified + automatable atoms (honest metric)', () => {
    const cov = computeReplacementCoverage(atoms);
    // only a1 is field_verified AND automatable → 1 of 3 non-human atoms
    expect(cov.replacedAtoms).toBe(1);
    expect(cov.automatableAtoms).toBe(3); // a1,a2,a4 (a3 is human)
    expect(cov.humanOnlyAtoms).toBe(1);
    expect(cov.replacementRate).toBeCloseTo(1 / 3, 5);
  });

  it('never counts a human-only atom toward replacement even if marked covered', () => {
    const sneaky: WorkAtom[] = [{ id: 'x', product: 'HCI', phase: 'deploy', title: 'rack', automatability: 'human', coveredBy: 'sangfor.something', maturity: 'field_verified' }];
    const cov = computeReplacementCoverage(sneaky);
    expect(cov.replacedAtoms).toBe(0);
    expect(cov.humanOnlyAtoms).toBe(1);
  });
});

describe('computeReplacementCoverage — red-team regressions', () => {
  it('does NOT count a field_verified atom as replaced unless it has evidence', () => {
    const noEvidence = [{ id: 'e1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor.x', maturity: 'field_verified' } as any];
    expect(computeReplacementCoverage(noEvidence).replacedAtoms).toBe(0);
    const withEvidence = [{ id: 'e2', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor.x', maturity: 'field_verified', evidence: 'outputs/diagnosis/EPP_6.0.4_live_diagnosis.md' } as any];
    expect(computeReplacementCoverage(withEvidence).replacedAtoms).toBe(1);
  });
  it('deduplicates WorkAtoms by id', () => {
    const dup = [
      { id: 'd', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' } as any,
      { id: 'd', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', maturity: 'planned' } as any,
    ];
    expect(computeReplacementCoverage(dup).automatableAtoms).toBe(1);
  });
});

describe('computeReplacementCoverage — verified coverage (knownTools + evidenceRoot)', () => {
  const knownTools = new Set(['sangfor.evaluate_config']);
  const evidenceRoot = process.cwd();

  it('(a) excludes an atom whose coveredBy is not a registered tool + reports it in unknownCoverage', () => {
    const orphan: WorkAtom[] = [
      { id: 'o1', product: 'EPP', phase: 'operate', title: 't', automatability: 'auto', coveredBy: 'sangfor.deleted_tool', maturity: 'field_verified', evidence: 'outputs/diagnosis/EPP_6.0.4_live_diagnosis.md' },
    ];
    const cov = computeReplacementCoverage(orphan, { knownTools, evidenceRoot });
    expect(cov.replacedAtoms).toBe(0);
    expect(cov.unknownCoverage).toEqual([{ atomId: 'o1', coveredBy: 'sangfor.deleted_tool' }]);
  });

  it('(b) excludes an atom whose evidence is prose (not a real path) + reports it in evidenceMissing', () => {
    const prose: WorkAtom[] = [
      { id: 'deploy_asbuilt_doc', product: 'HCI', phase: 'handover', title: 'as-built', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: 'outputs/ (generated setting/operations guides)' },
    ];
    const cov = computeReplacementCoverage(prose, { knownTools, evidenceRoot });
    expect(cov.replacedAtoms).toBe(0);
    expect(cov.evidenceMissing.map((e) => e.atomId)).toContain('deploy_asbuilt_doc');
  });

  it('(c) keeps an atom whose evidence is a real file and coveredBy is registered', () => {
    const real: WorkAtom[] = [
      { id: 'op_daily_health', product: 'EPP', phase: 'operate', title: 'daily health', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: 'outputs/diagnosis/EPP_6.0.4_live_diagnosis.md' },
    ];
    const cov = computeReplacementCoverage(real, { knownTools, evidenceRoot });
    expect(cov.replacedAtoms).toBe(1);
    expect(cov.unknownCoverage).toHaveLength(0);
    expect(cov.evidenceMissing).toHaveLength(0);
  });

  it('without opts, behavior is unchanged (backward compatible)', () => {
    const cov = computeReplacementCoverage(atoms);
    expect(cov.replacedAtoms).toBe(1);
    expect(cov.unknownCoverage).toEqual([]);
    expect(cov.evidenceMissing).toEqual([]);
  });

  it('rejects a bare directory as evidence (must be a real artifact FILE, not a folder)', () => {
    const dirEvidence: WorkAtom[] = [
      { id: 'd1', product: 'HCI', phase: 'handover', title: 'x', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: 'outputs' },
      { id: 'd2', product: 'HCI', phase: 'handover', title: 'x', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: '.' },
    ];
    const cov = computeReplacementCoverage(dirEvidence, { knownTools, evidenceRoot });
    expect(cov.replacedAtoms).toBe(0);
    expect(cov.evidenceMissing.map((e) => e.atomId).sort()).toEqual(['d1', 'd2']);
  });

  it('rejects an absolute or traversal evidence path that escapes the evidence root', () => {
    const escapes: WorkAtom[] = [
      { id: 'abs', product: 'X', phase: 'operate', title: 'x', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: '/etc/hosts' },
      { id: 'trav', product: 'X', phase: 'operate', title: 'x', automatability: 'auto', coveredBy: 'sangfor.evaluate_config', maturity: 'field_verified', evidence: '../../../../../../etc/hosts' },
    ];
    const cov = computeReplacementCoverage(escapes, { knownTools, evidenceRoot });
    expect(cov.replacedAtoms).toBe(0);
    expect(cov.evidenceMissing.map((e) => e.atomId).sort()).toEqual(['abs', 'trav']);
  });
});

describe('computeReplacementCoverage — maturity policy cross-check', () => {
  const baseVerifiedAtom: WorkAtom = {
    id: 'cap-cross',
    product: 'IAG',
    phase: 'operate',
    title: 'policy-backed capability',
    automatability: 'auto',
    coveredBy: 'sangfor.evaluate_config',
    maturity: 'field_verified',
    evidence: 'outputs/diagnosis/EPP_6.0.4_live_diagnosis.md',
    capabilityRef: { product: 'IAG', capabilityId: 'cap.policy' },
  };

  it('excludes field_verified atom claims when policy maturity is lower', () => {
    const cov = computeReplacementCoverage([baseVerifiedAtom], {
      maturityPolicy: [{ product: 'IAG', capabilityId: 'cap.policy', maturity: 'tested_mock' }],
    });

    expect(cov.replacedAtoms).toBe(0);
    expect(cov.maturityConflicts).toEqual([
      { atomId: 'cap-cross', atomMaturity: 'field_verified', policyMaturity: 'tested_mock' },
    ]);
    expect(cov.unverifiedClaims).toEqual([
      { atomId: 'cap-cross', reason: 'capability policy maturity tested_mock is lower than atom maturity field_verified' },
    ]);
  });

  it('keeps replaced status when policy maturity is equal or higher than atom maturity', () => {
    const equal = computeReplacementCoverage([baseVerifiedAtom], {
      maturityPolicy: [{ product: 'IAG', capabilityId: 'cap.policy', maturity: 'field_verified' }],
    });
    const higher = computeReplacementCoverage([
      { ...baseVerifiedAtom, id: 'cap-cross-local', maturity: 'tested_mock' },
    ], {
      maturityPolicy: [{ product: 'IAG', capabilityId: 'cap.policy', maturity: 'field_verified' }],
    });

    expect(equal.replacedAtoms).toBe(1);
    expect(equal.maturityConflicts).toEqual([]);
    expect(equal.unverifiedClaims).toEqual([]);
    expect(higher.replacedAtoms).toBe(0);
    expect(higher.maturityConflicts).toEqual([]);
    expect(higher.unverifiedClaims).toEqual([]);
  });

  it('does not cross-check atoms without capabilityRef', () => {
    const cov = computeReplacementCoverage([{ ...baseVerifiedAtom, id: 'no-ref', capabilityRef: undefined }], {
      maturityPolicy: [{ product: 'IAG', capabilityId: 'cap.policy', maturity: 'planned' }],
    });

    expect(cov.replacedAtoms).toBe(1);
    expect(cov.maturityConflicts).toEqual([]);
    expect(cov.unverifiedClaims).toEqual([]);
  });
});
