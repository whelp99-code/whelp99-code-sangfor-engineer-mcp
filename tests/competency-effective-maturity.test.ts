import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PromotionLedgerUnavailableError,
  computeEffectiveReplacementCoverage,
  maskedPromotionRef,
} from '../packages/sangfor-competency/src/index.js';
import {
  computeFixtureCoverage,
  createEffectiveFixture,
  requireEffectiveReport,
} from './helpers/effective-maturity-fixture.js';

const fixtures: Awaited<ReturnType<typeof createEffectiveFixture>>[] = [];
const setup = async (): Promise<Awaited<ReturnType<typeof createEffectiveFixture>>> => {
  const value = await createEffectiveFixture();
  fixtures.push(value);
  return value;
};
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

const promotion = (index: number, manifestRef?: string) => ({
  index,
  action: 'promote' as const,
  fromMaturity: 'tested_mock' as const,
  toMaturity: 'field_verified' as const,
  ...(manifestRef === undefined ? {} : { manifestRef }),
});

describe('effective replacement maturity', () => {
  it('Given exact active evidence and a valid human promotion, When coverage is computed, Then the exact atom is replaced', async () => {
    // Given
    const value = await setup();
    await value.ledger.append(value.event(promotion(1)));

    // When
    const report = requireEffectiveReport(await computeFixtureCoverage(value));

    // Then
    expect(report.replacedAtoms).toBe(1);
    expect(report.claimIssues).toEqual([]);
  });

  it('Given active evidence without an exact promotion, When coverage is computed, Then it reports an unverified claim rather than trusting catalog maturity', async () => {
    // Given
    const value = await setup();

    // When
    const report = requireEffectiveReport(await computeFixtureCoverage(value));

    // Then
    expect(report.replacedAtoms).toBe(0);
    expect(report.claimIssues).toEqual([expect.objectContaining({ state: 'unverified', effectiveMaturity: 'tested_mock' })]);
  });

  it('Given missing or duplicate current evidence claims, When coverage is computed, Then the report is invalid and keeps the denominator out of output', async () => {
    // Given
    const missing = await setup();
    const duplicate = await setup();

    // When
    const missingResult = await computeFixtureCoverage(missing, { claims: [] });
    const duplicateResult = await computeFixtureCoverage(duplicate, { claims: [duplicate.claim, duplicate.claim] });

    // Then
    expect(missingResult).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'activeEvidenceUnavailable', atomId: 'op_daily_health' })] });
    expect(duplicateResult).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'duplicateEvidenceClaim', atomId: 'op_daily_health' })] });
  });

  it('Given an invalid applied event or corrupt authenticated checkpoint, When coverage is computed, Then the report is invalid', async () => {
    // Given
    const invalid = await setup();
    await invalid.ledger.append(invalid.event({ ...promotion(1), fromMaturity: 'field_verified' }));
    const corrupt = await setup();
    await corrupt.ledger.append(corrupt.event(promotion(1)));
    writeFileSync(`${corrupt.ledgerPath}.head.json`, '{}');

    // When
    const invalidEvent = await computeFixtureCoverage(invalid);
    const corruptCheckpoint = await computeFixtureCoverage(corrupt);

    // Then
    expect(invalidEvent).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'promotionLedgerUnavailable' })] });
    expect(corruptCheckpoint).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'promotionLedgerUnavailable' })] });
  });

  it('Given an interrupted authenticated ledger read, When coverage is computed, Then the report is invalid without fallback', async () => {
    // Given
    const value = await setup();
    const interruptedLedger = {
      read: async () => { throw new PromotionLedgerUnavailableError(); },
      append: value.ledger.append.bind(value.ledger),
    };

    // When
    const result = await computeEffectiveReplacementCoverage(value.context, { claims: [value.claim], ledger: interruptedLedger });

    // Then
    expect(result).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'promotionLedgerUnavailable' })] });
  });

  it('Given demotion, When the same digest is re-promoted and then a new evidence digest is promoted, Then only the new cycle reactivates', async () => {
    // Given
    const value = await setup();
    await value.ledger.append(value.event(promotion(1)));
    await value.ledger.append(value.event({ index: 2, action: 'emergency_demote', fromMaturity: 'field_verified', toMaturity: 'tested_mock' }));
    await value.ledger.append(value.event(promotion(3)));

    // When
    const reused = requireEffectiveReport(await computeFixtureCoverage(value));
    const newManifest = { ...value.fixture.manifest, manifestId: 'manifest-api-read-only-new-cycle' };
    const newSource = JSON.stringify(newManifest);
    const newRef = maskedPromotionRef('manifest', createHash('sha256').update(newSource).digest('hex'));
    await value.ledger.append(value.event({ index: 4, action: 'emergency_demote', fromMaturity: 'field_verified', toMaturity: 'tested_mock' }));
    await value.ledger.append(value.event(promotion(5, newRef)));
    const reactivated = requireEffectiveReport(await computeFixtureCoverage(value, { claims: [{ ...value.claim, manifestSource: newSource }] }));

    // Then
    expect(reused.replacedAtoms).toBe(0);
    expect(reused.claimIssues[0]).toEqual(expect.objectContaining({ state: 'unverified' }));
    expect(reactivated.replacedAtoms).toBe(1);
  });
});
