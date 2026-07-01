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
