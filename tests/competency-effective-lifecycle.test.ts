import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  firmwareValueSchema,
  sha256Schema,
  type EvidenceValidationContext,
} from '../packages/sangfor-competency/src/index.js';
import {
  computeFixtureCoverage,
  createEffectiveFixture,
  requireEffectiveReport,
} from './helpers/effective-maturity-fixture.js';

const fixtures: Awaited<ReturnType<typeof createEffectiveFixture>>[] = [];
const setup = async (campaign: 'api_read_only' | 'browser' = 'api_read_only') => {
  const value = await createEffectiveFixture(campaign);
  fixtures.push(value);
  await value.ledger.append(value.event({ index: 1, action: 'promote', fromMaturity: 'tested_mock', toMaturity: 'field_verified' }));
  return value;
};
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

describe('effective maturity lifecycle', () => {
  it('Given API evidence at and just beyond 180 days, When the clock advances, Then equality stays active and one millisecond expires', async () => {
    // Given
    const value = await setup();
    const atBoundary = { ...value.fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.000Z') } };
    const afterBoundary = { ...value.fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.001Z') } };

    // When
    const active = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: atBoundary }));
    const stale = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: afterBoundary }));

    // Then
    expect(active.replacedAtoms).toBe(1);
    expect(stale.replacedAtoms).toBe(0);
    expect(stale.claimIssues).toEqual([expect.objectContaining({ state: 'stale', effectiveMaturity: 'tested_mock', evidenceIssueCodes: ['evidence_expired'] })]);
  });

  it('Given browser evidence at and just beyond 90 days, When coverage is computed, Then only the latter is stale', async () => {
    // Given
    const value = await setup('browser');
    const atBoundary = { ...value.fixture.context, clock: { now: () => new Date('2026-11-23T12:00:00.000Z') } };
    const afterBoundary = { ...value.fixture.context, clock: { now: () => new Date('2026-11-23T12:00:00.001Z') } };

    // When
    const active = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: atBoundary }));
    const stale = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: afterBoundary }));

    // Then
    expect(active.replacedAtoms).toBe(1);
    expect(stale.claimIssues[0]).toEqual(expect.objectContaining({ state: 'stale', effectiveMaturity: 'tested_mock' }));
  });

  it('Given current digest or firmware drift, When coverage is computed, Then maturity drops immediately with an explicit stale claim', async () => {
    // Given
    const value = await setup();
    const context = {
      ...value.fixture.context,
      currentDigests: { ...value.fixture.context.currentDigests, runtimeDigest: sha256Schema.parse('e'.repeat(64)) },
      currentFirmware: { ...value.fixture.context.currentFirmware, versionRaw: firmwareValueSchema.parse('6.10.0R3') },
    } satisfies EvidenceValidationContext;

    // When
    const report = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: context }));

    // Then
    expect(report.replacedAtoms).toBe(0);
    expect(report.claimIssues[0]).toEqual(expect.objectContaining({ state: 'stale', evidenceIssueCodes: ['identity_drift', 'identity_drift'] }));
  });

  it('Given emergency demotion, When coverage is computed, Then history remains and the claim is demoted immediately', async () => {
    // Given
    const value = await setup();
    await value.ledger.append(value.event({ index: 2, action: 'emergency_demote', fromMaturity: 'field_verified', toMaturity: 'tested_mock' }));

    // When
    const report = requireEffectiveReport(await computeFixtureCoverage(value));

    // Then
    expect(value.ledger.read()).toHaveLength(2);
    expect(report.replacedAtoms).toBe(0);
    expect(report.claimIssues).toEqual([expect.objectContaining({ state: 'demoted', effectiveMaturity: 'tested_mock' })]);
  });

  it('Given the canonical 20 atom shape, When active evidence becomes stale, Then its denominator remains stable', async () => {
    // Given
    const value = await setup();
    const atoms = JSON.parse(readFileSync(join(value.context.catalogRoot, 'work-atoms.json'), 'utf8')) as { atoms: Record<string, unknown>[] };
    atoms.atoms.push(...Array.from({ length: 15 }, (_, index) => ({ id: `auto-${index}`, product: 'HCI_SCP', phase: 'operate', title: `auto ${index}`, automatability: 'auto', maturity: 'tested_mock' })));
    atoms.atoms.push(...Array.from({ length: 4 }, (_, index) => ({ id: `human-${index}`, product: 'HCI_SCP', phase: 'deploy', title: `human ${index}`, automatability: 'human', humanReason: 'physical', maturity: 'planned' })));
    writeFileSync(join(value.context.catalogRoot, 'work-atoms.json'), JSON.stringify(atoms));
    const staleContext = { ...value.fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.001Z') } };

    // When
    const report = requireEffectiveReport(await computeFixtureCoverage(value, { validationContext: staleContext }));

    // Then
    expect(report).toEqual(expect.objectContaining({ totalAtoms: 20, automatableAtoms: 16, humanOnlyAtoms: 4, replacedAtoms: 0 }));
  });
});
