import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  capabilityEvidenceManifestSchema,
  capabilityEvidenceRunSchema,
} from '../packages/sangfor-competency/src/index.js';

const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(
  new URL('./fixtures/capability-evidence/valid-manifest.json', import.meta.url),
  'utf8',
)));
const firstRun = capabilityEvidenceRunSchema.parse(manifest.runs[0]);
const secondRun = capabilityEvidenceRunSchema.parse({
  ...firstRun,
  id: 'run-002',
  executor: { actorId: 'ai-engineer-08', actorType: 'ai_engineer' },
  independentReadBack: {
    ...firstRun.independentReadBack,
    verifier: { actorId: 'verifier-service-03', actorType: 'service' },
  },
});
const twoRunCounters = {
  ...manifest.o5Counters,
  runCount: 2,
  passCount: 2,
  independentReadBackPassCount: 2,
  restoredCount: 2,
  mutationCount: 2,
};

describe('capability evidence global ownership', () => {
  it('rejects run, read-back, and restore artifacts shared by two runs', () => {
    // Given
    const sharedArtifacts = {
      ...manifest,
      runs: [firstRun, { ...secondRun, negativeCaseIds: [] }],
      o5Counters: twoRunCounters,
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(sharedArtifacts);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects a negative case and its artifact set shared by two runs', () => {
    // Given
    const sharedNegative = {
      ...manifest,
      runs: [firstRun, secondRun],
      o5Counters: twoRunCounters,
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(sharedNegative);

    // Then
    expect(result.success).toBe(false);
  });
});

describe('capability evidence firmware chronology', () => {
  it('rejects firmware truth observed after the earliest run starts', () => {
    // Given
    const postRunTruth = {
      ...manifest,
      firmwareTruth: { ...manifest.firmwareTruth, observedAt: '2026-08-25T11:01:00.000Z' },
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(postRunTruth);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects firmware truth observed after manifest generation', () => {
    // Given
    const postGenerationTruth = {
      ...manifest,
      firmwareTruth: { ...manifest.firmwareTruth, observedAt: '2026-08-25T13:00:00.000Z' },
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(postGenerationTruth);

    // Then
    expect(result.success).toBe(false);
  });
});
