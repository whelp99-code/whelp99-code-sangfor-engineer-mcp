import { describe, expect, it } from 'vitest';
import {
  compareRemoteShadow,
  parseRemoteShadowObservation,
  type RemoteShadowObservation,
} from '../packages/sangfor-observer/src/remote-shadow.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

type Timing = {
  readonly collectedAt: string;
  readonly latencyMs: number;
};

function observation(path: 'local' | 'remote', timing: Timing): RemoteShadowObservation {
  return parseRemoteShadowObservation({
    schemaVersion: 'remote-shadow-observation.v1', path,
    target: {
      tenantId: 'tenant-a', projectId: 'project-a', installationId: 'installation-a',
      deviceBindingDigest: 'd'.repeat(64), origin: 'https://device.example.test',
      sourceScope: 'device-a/config', sourceVersion: 'firmware-8.0.75',
    },
    readOnly: true,
    execution: {
      schemaVersion: 'browser-execution-result.v1', requestId: `${path}-request`, status: 'PASS',
      mutationAttempted: false, readBack: { status: 'PASS' },
      observations: { collectorMetadata: timing }, evidence: [],
    },
    requiredFacts: [{
      key: 'system', value: { enabled: true }, ordering: 'ordered',
      provenance: {
        endpoint: 'GET /api/system', collector: 'config-collector', collectorVersion: '2.1.0',
        mapperVersion: '1.0.0', transport: 'browser', sourceIdentity: 'device-a',
        sourceScope: 'device-a/config', ...timing,
      },
    }],
  });
}

function compare(local: RemoteShadowObservation, remote: RemoteShadowObservation) {
  return compareRemoteShadow({ local, remote, now: NOW, maxAgeMs: 60_000 });
}

function drift(
  observationInput: RemoteShadowObservation,
  changed: Readonly<Record<string, unknown>>,
): RemoteShadowObservation {
  const fact = observationInput.requiredFacts[0];
  return parseRemoteShadowObservation({
    ...observationInput,
    requiredFacts: [{ ...fact, provenance: { ...fact?.provenance, ...changed } }],
  });
}

describe('remote shadow acquisition metadata', () => {
  it('Given distinct fresh collection times and latencies, When compared, Then PASS and semantic digests ignore timing', () => {
    // Given
    const equalLocal = observation('local', { collectedAt: '2026-08-27T11:59:40.000Z', latencyMs: 12 });
    const equalRemote = observation('remote', { collectedAt: '2026-08-27T11:59:40.000Z', latencyMs: 12 });
    const distinctLocal = observation('local', { collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 });
    const distinctRemote = observation('remote', { collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 });
    // When
    const equal = compare(equalLocal, equalRemote);
    const distinct = compare(distinctLocal, distinctRemote);
    // Then
    expect(distinct).toMatchObject({
      verdict: 'PASS',
      localAcquisition: [{ factKey: 'system', collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 }],
      remoteAcquisition: [{ factKey: 'system', collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 }],
    });
    expect(distinct.localObservationDigest).toBe(equal.localObservationDigest);
    expect(distinct.remoteObservationDigest).toBe(equal.remoteObservationDigest);
    expect(distinct.localProvenanceDigest).toBe(equal.localProvenanceDigest);
    expect(distinct.remoteProvenanceDigest).toBe(equal.remoteProvenanceDigest);
    expect(distinct.reportDigest).toBe(equal.reportDigest);
  });

  it.each([
    ['endpoint', { endpoint: 'GET /api/v2/system' }],
    ['collector version', { collectorVersion: '2.2.0' }],
    ['transport', { transport: 'api' }],
    ['source', { sourceIdentity: 'device-b' }],
  ])('Given %s semantic provenance drift, When compared, Then promotion mismatches', (_name, changed) => {
    // Given
    const local = observation('local', { collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 });
    const remote = drift(observation('remote', { collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 }), changed);
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).toBe('MISMATCH');
    expect(report.issues.map((issue) => issue.kind)).toContain('PROVENANCE_MISMATCH');
  });
});
