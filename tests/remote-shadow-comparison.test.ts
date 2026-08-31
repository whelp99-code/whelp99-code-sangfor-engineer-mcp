import { describe, expect, it } from 'vitest';
import {
  compareRemoteShadow,
  parseRemoteShadowObservation,
  type RemoteShadowObservation,
} from '../packages/sangfor-observer/src/remote-shadow.js';
import { runRemoteShadowCli } from '../packages/sangfor-observer/src/remote-shadow-cli.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function observation(path: 'local' | 'remote'): RemoteShadowObservation {
  return parseRemoteShadowObservation({
    schemaVersion: 'remote-shadow-observation.v1',
    path,
    target: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      installationId: 'installation-a',
      deviceBindingDigest: 'd'.repeat(64),
      origin: 'https://device.example.test',
      sourceScope: 'device-a/config',
      sourceVersion: 'firmware-8.0.75',
    },
    readOnly: true,
    execution: {
      schemaVersion: 'browser-execution-result.v1',
      requestId: `${path}-request`,
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      evidence: [],
    },
    requiredFacts: [
      {
        key: 'interfaces',
        value: [{ name: 'eth1', zones: ['wan', 'trusted'] }, { name: 'eth0', zones: ['lan'] }],
        ordering: 'unordered',
        provenance: {
          endpoint: 'GET /api/interfaces',
          collectedAt: '2026-08-27T11:59:30.000Z',
          collector: 'jm-config-collector',
          collectorVersion: '2.1.0',
          mapperVersion: '1.0.0',
          transport: 'browser',
          sourceIdentity: 'device-a',
          sourceScope: 'device-a/config',
          latencyMs: 17,
        },
      },
      {
        key: 'system',
        value: { enabled: true, retries: 3 },
        ordering: 'ordered',
        provenance: {
          endpoint: 'GET /api/system',
          collectedAt: '2026-08-27T11:59:30.000Z',
          collector: 'jm-config-collector',
          collectorVersion: '2.1.0',
          mapperVersion: '1.0.0',
          transport: 'browser',
          sourceIdentity: 'device-a',
          sourceScope: 'device-a/config',
          latencyMs: 11,
        },
      },
    ],
  });
}

function replaceFact(
  input: RemoteShadowObservation,
  key: string,
  replacement: (fact: RemoteShadowObservation['requiredFacts'][number]) => unknown,
): RemoteShadowObservation {
  return parseRemoteShadowObservation({
    ...input,
    requiredFacts: input.requiredFacts.map((fact) => fact.key === key ? replacement(fact) : fact),
  });
}

function compare(local: RemoteShadowObservation, remote: RemoteShadowObservation) {
  return compareRemoteShadow({ local, remote, now: NOW, maxAgeMs: 60_000 });
}

describe('remote shadow promotion comparison', () => {
  it('Given exact current read-only observations without authenticated proof, When compared, Then comparison passes candidate-only', () => {
    // Given
    const local = observation('local');
    const remote = observation('remote');
    // When
    const report = compare(local, remote);
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_CANDIDATE', promotionEligible: false, factCount: 2 });
  });

  it.each([
    ['missing', (remote: RemoteShadowObservation) => parseRemoteShadowObservation({ ...remote, requiredFacts: remote.requiredFacts.slice(1) })],
    ['extra', (remote: RemoteShadowObservation) => parseRemoteShadowObservation({ ...remote, requiredFacts: [...remote.requiredFacts, { ...remote.requiredFacts[0], key: 'unexpected' }] })],
  ])('Given a %s required fact, When compared, Then promotion mismatches', (_name, mutate) => {
    // Given
    const local = observation('local');
    const remote = mutate(observation('remote'));
    // When
    const report = compare(local, remote);
    // Then
    expect(report).toMatchObject({ verdict: 'MISMATCH', code: 'REMOTE_SHADOW_MISMATCH', promotionEligible: false });
    expect(report.issues.map((issue) => issue.kind)).toContain('FACT_SET_MISMATCH');
  });

  it.each([
    ['value', (fact: RemoteShadowObservation['requiredFacts'][number]) => ({ ...fact, value: { enabled: false, retries: 3 } })],
    ['type', (fact: RemoteShadowObservation['requiredFacts'][number]) => ({ ...fact, value: { enabled: true, retries: '3' } })],
    ['provenance', (fact: RemoteShadowObservation['requiredFacts'][number]) => ({ ...fact, provenance: { ...fact.provenance, endpoint: 'GET /api/v2/system' } })],
  ])('Given %s drift, When compared, Then exact agreement is refused', (_name, mutate) => {
    // Given
    const local = observation('local');
    const remote = replaceFact(observation('remote'), 'system', mutate);
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).toBe('MISMATCH');
    expect(report.issues.some((issue) => issue.kind === 'VALUE_MISMATCH' || issue.kind === 'PROVENANCE_MISMATCH')).toBe(true);
  });

  it.each([
    ['stale', '2026-08-27T11:58:59.999Z'],
    ['future', '2026-08-27T12:00:00.001Z'],
  ])('Given a %s timestamp, When compared, Then freshness fails closed', (_name, collectedAt) => {
    // Given
    const local = observation('local');
    const remote = replaceFact(observation('remote'), 'system', (fact) => ({ ...fact, provenance: { ...fact.provenance, collectedAt } }));
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).toBe('MISMATCH');
    expect(report.issues.map((issue) => issue.kind)).toContain(_name === 'stale' ? 'STALE_FACT' : 'FUTURE_FACT');
  });

  it('Given ordering-only differences declared unordered, When compared, Then values match', () => {
    // Given
    const local = observation('local');
    const remote = replaceFact(observation('remote'), 'interfaces', (fact) => ({ ...fact, value: Array.isArray(fact.value) ? [...fact.value].reverse() : fact.value }));
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).toBe('PASS');
  });

  it('Given ordering-only differences not declared unordered, When compared, Then values mismatch', () => {
    // Given
    const local = replaceFact(observation('local'), 'interfaces', (fact) => ({ ...fact, ordering: 'ordered' }));
    const remote = replaceFact(observation('remote'), 'interfaces', (fact) => ({ ...fact, ordering: 'ordered', value: Array.isArray(fact.value) ? [...fact.value].reverse() : fact.value }));
    // When
    const report = compare(local, remote);
    // Then
    expect(report.issues.map((issue) => issue.kind)).toContain('VALUE_MISMATCH');
  });

  it.each([
    ['INDETERMINATE', { status: 'INDETERMINATE', readBack: { status: 'INDETERMINATE' }, mutationAttempted: false }],
    ['refusal', { status: 'REFUSED', mutationAttempted: false }],
    ['mutation attempt', { status: 'PASS', readBack: { status: 'PASS' }, mutationAttempted: true }],
  ])('Given %s execution, When compared, Then it never promotes', (_name, execution) => {
    // Given
    const local = observation('local');
    const remote = parseRemoteShadowObservation({ ...observation('remote'), execution: { ...observation('remote').execution, ...execution } });
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).toBe('MISMATCH');
    expect(report.issues.map((issue) => issue.kind)).toContain('NON_AUTHORITATIVE_EXECUTION');
  });

  it.each([
    ['scope', { sourceScope: 'device-b/config' }],
    ['version', { sourceVersion: 'firmware-9.0.0' }],
  ])('Given cross-%s observations, When compared, Then target binding mismatches', (_name, changed) => {
    // Given
    const local = observation('local');
    const remote = parseRemoteShadowObservation({ ...observation('remote'), target: { ...observation('remote').target, ...changed } });
    // When
    const report = compare(local, remote);
    // Then
    expect(report.issues.map((issue) => issue.kind)).toContain('TARGET_MISMATCH');
  });

  it('Given secret-bearing data, When compared, Then diagnostics are redacted and promotion refuses', () => {
    // Given
    const secret = 'Bearer customer-browser-secret';
    const local = replaceFact(observation('local'), 'system', (fact) => ({ ...fact, value: { cookie: secret } }));
    const remote = replaceFact(observation('remote'), 'system', (fact) => ({ ...fact, value: { cookie: secret } }));
    // When
    const report = compare(local, remote);
    // Then
    expect(report.issues.map((issue) => issue.kind)).toContain('SECRET_BEARING_DATA');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('Given malformed, duplicate, or nondeterministic facts, When parsed, Then input is refused', () => {
    // Given
    const valid = observation('local');
    const malformed = [
      { ...valid, requiredFacts: [...valid.requiredFacts, valid.requiredFacts[0]] },
      { ...valid, requiredFacts: [{ ...valid.requiredFacts[0], provenance: { endpoint: 'GET /x' } }] },
      { ...valid, requiredFacts: [{ ...valid.requiredFacts[0], value: Number.NaN }] },
    ];
    // When
    const parse = (value: unknown) => () => parseRemoteShadowObservation(value);
    // Then
    for (const value of malformed) expect(parse(value)).toThrow();
  });

  it('Given nondeterministic input ordering, When compared, Then canonical report digests are deterministic', () => {
    // Given
    const firstLocal = observation('local');
    const firstRemote = observation('remote');
    const secondLocal = parseRemoteShadowObservation({ ...firstLocal, requiredFacts: [...firstLocal.requiredFacts].reverse() });
    const secondRemote = replaceFact(parseRemoteShadowObservation({ ...firstRemote, requiredFacts: [...firstRemote.requiredFacts].reverse() }), 'system', (fact) => ({ ...fact, value: { retries: 3, enabled: true } }));
    // When
    const first = compare(firstLocal, firstRemote);
    const second = compare(secondLocal, secondRemote);
    // Then
    expect(second.reportDigest).toBe(first.reportDigest);
    expect(second.localObservationDigest).toBe(first.localObservationDigest);
    expect(second.remoteObservationDigest).toBe(first.remoteObservationDigest);
  });

  it.each([
    ['ignore missing', (remote: RemoteShadowObservation) => parseRemoteShadowObservation({ ...remote, requiredFacts: remote.requiredFacts.slice(1) })],
    ['strip provenance', (remote: RemoteShadowObservation) => replaceFact(remote, 'system', (fact) => ({ ...fact, provenance: { ...fact.provenance, endpoint: 'GET /drift' } }))],
    ['treat INDETERMINATE as PASS', (remote: RemoteShadowObservation) => parseRemoteShadowObservation({ ...remote, execution: { ...remote.execution, status: 'INDETERMINATE', readBack: { status: 'INDETERMINATE' } } })],
    ['broad array sorting', (remote: RemoteShadowObservation) => replaceFact(remote, 'interfaces', (fact) => ({ ...fact, ordering: 'ordered', value: Array.isArray(fact.value) ? [...fact.value].reverse() : fact.value }))],
  ])('Given the negative mutation %s, When compared, Then the report cannot PASS', (_name, mutate) => {
    // Given
    const local = _name === 'broad array sorting'
      ? replaceFact(observation('local'), 'interfaces', (fact) => ({ ...fact, ordering: 'ordered' }))
      : observation('local');
    const remote = mutate(observation('remote'));
    // When
    const report = compare(local, remote);
    // Then
    expect(report.verdict).not.toBe('PASS');
  });
});

describe('remote shadow CLI', () => {
  it('Given --help, When invoked, Then usage is printed successfully', async () => {
    // Given
    const output: string[] = [];
    // When
    const code = await runRemoteShadowCli(['--help'], { write: (line) => output.push(line), readText: async () => '' });
    // Then
    expect(code).toBe(0);
    expect(output.join('\n')).toContain('Usage: remote-shadow-compare');
  });

  it('Given strict bad input, When invoked, Then it reports mismatch without leaking input', async () => {
    // Given
    const output: string[] = [];
    // When
    const code = await runRemoteShadowCli(['--local', 'local.json', '--remote', 'remote.json', '--now', NOW.toISOString(), '--max-age-ms', '60000'], {
      write: (line) => output.push(line),
      readText: async () => '{"password":"customer-secret"}',
    });
    // Then
    expect(code).toBe(2);
    expect(output.join('\n')).toContain('REMOTE_SHADOW_MISMATCH');
    expect(output.join('\n')).not.toContain('customer-secret');
  });
});
