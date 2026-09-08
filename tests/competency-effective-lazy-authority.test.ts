import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCoverageContext,
  computeEffectiveReplacementCoverage,
} from '../packages/sangfor-competency/src/index.js';

const roots: string[] = [];
function catalog(atoms: readonly Record<string, unknown>[]) {
  const catalogRoot = mkdtempSync(join(tmpdir(), 'effective-lazy-catalog-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'effective-lazy-evidence-'));
  roots.push(catalogRoot, evidenceRoot);
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));
  return buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: [{ product: 'HCI_SCP', capabilityId: 'resource_inventory', maturity: 'tested_mock' }],
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('lazy effective authority requirements', () => {
  it('Given only lower-maturity automatable atoms, When coverage has no authority, Then it reports valid zero coverage', async () => {
    // Given
    const context = catalog([
      { id: 'planned', product: 'HCI_SCP', phase: 'design', title: 'planned', automatability: 'auto', maturity: 'planned' },
      { id: 'local', product: 'HCI_SCP', phase: 'deploy', title: 'local', automatability: 'hybrid', maturity: 'implemented_local' },
      { id: 'mock', product: 'HCI_SCP', phase: 'operate', title: 'mock', automatability: 'auto', maturity: 'tested_mock' },
    ]);

    // When
    const result = await computeEffectiveReplacementCoverage(context);

    // Then
    expect(result).toEqual({
      ok: true,
      report: expect.objectContaining({ totalAtoms: 3, automatableAtoms: 3, humanOnlyAtoms: 0, replacedAtoms: 0, claimIssues: [] }),
    });
  });

  it('Given a human-only field claim, When coverage has no authority, Then it never requires evidence or ledger state', async () => {
    // Given
    const context = catalog([{
      id: 'physical', product: 'HCI_SCP', phase: 'deploy', title: 'rack hardware',
      automatability: 'human', humanReason: 'physical work', maturity: 'field_verified',
    }]);

    // When
    const result = await computeEffectiveReplacementCoverage(context);

    // Then
    expect(result).toEqual({
      ok: true,
      report: expect.objectContaining({ totalAtoms: 1, automatableAtoms: 0, humanOnlyAtoms: 1, replacedAtoms: 0, claimIssues: [] }),
    });
  });

  it('Given an automatable field claim, When coverage has no authority, Then it remains invalid without a fallback', async () => {
    // Given
    const context = catalog([{
      id: 'field', product: 'HCI_SCP', phase: 'operate', title: 'field', automatability: 'auto',
      coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified', evidence: 'citation.md',
      capabilityRef: { product: 'HCI_SCP', capabilityId: 'resource_inventory' },
    }]);
    writeFileSync(join(context.evidenceRoot, 'citation.md'), 'historical citation\n');

    // When
    const result = await computeEffectiveReplacementCoverage(context);

    // Then
    expect(result).toEqual({ ok: false, violations: expect.arrayContaining([
      expect.objectContaining({ kind: 'activeEvidenceUnavailable' }),
      expect.objectContaining({ kind: 'promotionLedgerUnavailable' }),
    ]) });
  });
});
