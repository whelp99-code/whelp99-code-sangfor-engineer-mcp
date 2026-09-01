import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as competency from '../packages/sangfor-competency/src/index.js';
import {
  nodeEvidenceFilesystem,
  validateAndPersistEvidenceStaleness,
  type EvidenceValidationContext,
} from '../packages/sangfor-competency/src/index.js';
import { createEffectiveFixture } from './helpers/effective-maturity-fixture.js';

const fixtures: Awaited<ReturnType<typeof createEffectiveFixture>>[] = [];
const setup = async () => {
  const value = await createEffectiveFixture();
  fixtures.push(value);
  return value;
};
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

function input(value: Awaited<ReturnType<typeof setup>>, context: EvidenceValidationContext) {
  return {
    manifestSource: value.claim.manifestSource,
    manifest: value.fixture.manifest,
    evidenceRoot: value.claim.evidenceRoot,
    filesystem: nodeEvidenceFilesystem(),
    context,
    baseline: 'tested_mock' as const,
    ledger: value.ledger,
  };
}

function driftContext(value: Awaited<ReturnType<typeof setup>>): EvidenceValidationContext {
  return {
    ...value.fixture.context,
    clock: { now: () => new Date('2026-08-25T12:11:00.000Z') },
    currentDigests: {
      ...value.fixture.context.currentDigests,
      runtimeDigest: value.fixture.context.currentDigests.recipeDigest,
    },
  };
}

describe('validate-and-persist evidence staleness boundary', () => {
  it('Given a forged caller stale union and active evidence, When the boundary runs, Then no public raw seam exists and nothing appends', async () => {
    // Given
    const value = await setup();
    const forged = {
      ...input(value, value.fixture.context),
      validation: { status: 'stale', issues: [{ code: 'identity_drift', path: ['forged'] }] },
    };

    // When
    const result = await validateAndPersistEvidenceStaleness(forged);

    // Then
    expect('persistStaleEvidenceInvalidation' in competency).toBe(false);
    expect(result).toEqual({ status: 'no_change', evidenceStatus: 'active' });
    expect(value.ledger.read()).toEqual([]);
  });

  it('Given active context, When the boundary recomputes Todo 8 validation, Then it does not append', async () => {
    // Given
    const value = await setup();

    // When
    const result = await validateAndPersistEvidenceStaleness(input(value, value.fixture.context));

    // Then
    expect(result).toEqual({ status: 'no_change', evidenceStatus: 'active' });
    expect(value.ledger.read()).toEqual([]);
  });

  it.each([
    ['drift', (value: Awaited<ReturnType<typeof setup>>) => driftContext(value), 'identity_drift'],
    ['expiry', (value: Awaited<ReturnType<typeof setup>>) => ({ ...value.fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.001Z') } }), 'evidence_expired'],
  ] as const)('Given genuine %s, When validation runs immediately before append, Then a computed stale event is persisted', async (_name, context, reason) => {
    // Given
    const value = await setup();

    // When
    const result = await validateAndPersistEvidenceStaleness(input(value, context(value)));

    // Then
    expect(result).toMatchObject({ status: 'applied', event: { action: 'stale', invalidation: { reason } } });
    expect(value.ledger.read()).toHaveLength(1);
  });

  it('Given context changes between calls, When the boundary runs each time, Then only the newly computed stale call appends', async () => {
    // Given
    const value = await setup();

    // When
    const active = await validateAndPersistEvidenceStaleness(input(value, value.fixture.context));
    const stale = await validateAndPersistEvidenceStaleness(input(value, driftContext(value)));

    // Then
    expect(active.status).toBe('no_change');
    expect(stale.status).toBe('applied');
    expect(value.ledger.read().map(({ action }) => action)).toEqual(['stale']);
  });

  it('Given validation infrastructure is unavailable, When the boundary recomputes, Then it returns indeterminate without append', async () => {
    // Given
    const value = await setup();
    const unavailable = {
      ...input(value, driftContext(value)),
      context: {
        ...driftContext(value),
        clock: { now: () => { throw new Error('clock unavailable'); } },
      },
    };

    // When
    const result = await validateAndPersistEvidenceStaleness(unavailable);

    // Then
    expect(result).toEqual({ status: 'indeterminate', reason: 'validation_unavailable' });
    expect(value.ledger.read()).toEqual([]);
  });

  it('Given refused evidence bytes, When the boundary validates, Then it returns refusal without append', async () => {
    // Given
    const value = await setup();
    const firstArtifact = value.fixture.manifest.artifacts[0];
    if (firstArtifact === undefined) throw new Error('artifact fixture unavailable');
    writeFileSync(join(value.claim.evidenceRoot, firstArtifact.path), '{"forged":true}');

    // When
    const result = await validateAndPersistEvidenceStaleness(input(value, driftContext(value)));

    // Then
    expect(result).toMatchObject({ status: 'refused', evidenceStatus: 'refused' });
    expect(value.ledger.read()).toEqual([]);
  });
});
