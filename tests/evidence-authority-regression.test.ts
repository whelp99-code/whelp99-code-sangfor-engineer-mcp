import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserExecutionAuthorityPort,
  type BrowserExecutionPort,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { createIagExecutor } from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  compareRemoteShadow,
  parseRemoteShadowObservation,
  remoteShadowPromotionPayload,
  remoteShadowReportSchema,
  type RemoteShadowObservation,
  type RemoteShadowPromotionProof,
  type RemoteShadowPromotionTrust,
} from '../packages/sangfor-observer/src/remote-shadow.js';
import { runRemoteShadowCli } from '../packages/sangfor-observer/src/remote-shadow-cli.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function observation(path: 'local' | 'remote', sourceVersion = 'mock-v1'): RemoteShadowObservation {
  return parseRemoteShadowObservation({
    schemaVersion: 'remote-shadow-observation.v1',
    path,
    target: {
      tenantId: 'tenant-a', projectId: 'project-a', installationId: 'installation-a',
      deviceBindingDigest: 'd'.repeat(64), origin: 'https://device.example.test',
      sourceScope: 'device-a/config', sourceVersion,
    },
    readOnly: true,
    execution: {
      schemaVersion: 'browser-execution-result.v1', requestId: `${path}-request`, status: 'PASS',
      mutationAttempted: false, readBack: { status: 'PASS' }, evidence: [],
    },
    requiredFacts: [{
      key: 'system', value: { enabled: true }, ordering: 'ordered',
      provenance: {
        endpoint: 'GET /api/system', collectedAt: '2026-08-27T11:59:30.000Z',
        collector: 'config-collector', collectorVersion: '2.1.0', mapperVersion: '1.0.0',
        transport: 'browser',
        sourceIdentity: 'device-a', sourceScope: 'device-a/config', latencyMs: 10,
      },
    }],
  });
}

function compare(local: RemoteShadowObservation, remote: RemoteShadowObservation) {
  return compareRemoteShadow({ local, remote, now: NOW, maxAgeMs: 60_000 });
}

function promotionFixture(sourceVersion = 'firmware-8.0.75') {
  const local = observation('local', sourceVersion);
  const remote = observation('remote', sourceVersion);
  const candidate = compare(local, remote);
  const localKeys = generateKeyPairSync('ed25519');
  const remoteKeys = generateKeyPairSync('ed25519');
  const signed = (side: 'local' | 'remote', observationDigest: string, privateKey: typeof localKeys.privateKey) =>
    sign(null, Buffer.from(remoteShadowPromotionPayload({
      side, observationDigest, sourceIdentity: 'device-a', sourceScope: 'device-a/config',
    }), 'utf8'), privateKey).toString('base64');
  const proof: RemoteShadowPromotionProof = {
    schemaVersion: 'remote-shadow-promotion-proof.v1', evidenceClass: 'real',
    sourceIdentity: 'device-a', sourceScope: 'device-a/config',
    local: {
      keyId: 'local-key', observationDigest: candidate.localObservationDigest,
      signature: signed('local', candidate.localObservationDigest, localKeys.privateKey),
    },
    remote: {
      keyId: 'remote-key', observationDigest: candidate.remoteObservationDigest,
      signature: signed('remote', candidate.remoteObservationDigest, remoteKeys.privateKey),
    },
  };
  const trust: RemoteShadowPromotionTrust = {
    local: { keyId: 'local-key', publicKey: localKeys.publicKey },
    remote: { keyId: 'remote-key', publicKey: remoteKeys.publicKey },
  };
  return { local, remote, proof, trust, privateKey: localKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

describe('evidence authority regressions', () => {
  it('Given two plain wrappers over one delegate, When IAG is composed, Then unregistered authority is refused', () => {
    // Given
    const delegate: BrowserExecutionPort = { execute: vi.fn<BrowserExecutionPort['execute']>() };
    const executionPort: BrowserExecutionPort = { execute: (request, context) => delegate.execute(request, context) };
    const readBackPort: BrowserExecutionPort = { execute: (request, context) => delegate.execute(request, context) };
    // When
    const compose = () => createIagExecutor({ executionPort, readBackPort, now: () => NOW });
    // Then
    expect(compose).toThrow('IAG_INDEPENDENT_READ_BACK_PORT_REQUIRED');
  });

  it('Given separately registered delegates, When IAG is composed, Then distinct authorities are accepted', () => {
    // Given
    const executionPort = createBrowserExecutionAuthorityPort({ execute: vi.fn<BrowserExecutionPort['execute']>() });
    const readBackPort = createBrowserExecutionAuthorityPort({ execute: vi.fn<BrowserExecutionPort['execute']>() });
    // When
    const compose = () => createIagExecutor({ executionPort, readBackPort, now: () => NOW });
    // Then
    expect(compose).not.toThrow();
  });

  it('Given agreeing mock observations, When compared, Then PASS remains candidate-only', () => {
    // Given
    const local = observation('local');
    const remote = observation('remote');
    // When
    const report = compare(local, remote);
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_CANDIDATE', promotionEligible: false });
    expect(() => remoteShadowReportSchema.parse({ ...report, promotionEligible: true })).toThrow();
  });

  it('Given independently signed real same-scope identities, When compared, Then promotion is eligible without persisting signing secrets', () => {
    // Given
    const fixture = promotionFixture();
    // When
    const report = compareRemoteShadow({
      local: fixture.local, remote: fixture.remote, now: NOW, maxAgeMs: 60_000,
      promotionProof: fixture.proof, promotionTrust: fixture.trust,
    });
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_PASS', promotionEligible: true });
    expect(JSON.stringify(report)).not.toContain(fixture.proof.local.signature);
    expect(JSON.stringify(report)).not.toContain(fixture.privateKey);
  });

  it('Given a forged real identity signature, When facts agree, Then comparison PASS remains candidate-only', () => {
    // Given
    const fixture = promotionFixture();
    const forged = { ...fixture.proof, local: { ...fixture.proof.local, signature: fixture.proof.remote.signature } };
    // When
    const report = compareRemoteShadow({
      local: fixture.local, remote: fixture.remote, now: NOW, maxAgeMs: 60_000,
      promotionProof: forged, promotionTrust: fixture.trust,
    });
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_CANDIDATE', promotionEligible: false });
  });

  it('Given authenticated identities over mock-v1 sources, When facts agree, Then comparison PASS remains candidate-only', () => {
    // Given
    const fixture = promotionFixture('mock-v1');
    // When
    const report = compareRemoteShadow({
      local: fixture.local, remote: fixture.remote, now: NOW, maxAgeMs: 60_000,
      promotionProof: fixture.proof, promotionTrust: fixture.trust,
    });
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_CANDIDATE', promotionEligible: false });
  });

  it('Given self-asserted authority fields, When parsed, Then forged evidence is refused', () => {
    // Given
    const forged = { ...observation('remote'), evidenceClass: 'real', authenticated: true };
    // When
    const parse = () => parseRemoteShadowObservation(forged);
    // Then
    expect(parse).toThrow();
  });

  it('Given authenticated proof for a different target scope, When facts agree, Then PASS cannot promote', () => {
    // Given
    const fixture = promotionFixture();
    const retarget = (value: RemoteShadowObservation) => parseRemoteShadowObservation({
      ...value, target: { ...value.target, sourceScope: 'device-b/config' },
    });
    // When
    const report = compareRemoteShadow({
      local: retarget(fixture.local), remote: retarget(fixture.remote), now: NOW, maxAgeMs: 60_000,
      promotionProof: fixture.proof, promotionTrust: fixture.trust,
    });
    // Then
    expect(report).toMatchObject({ verdict: 'PASS', code: 'REMOTE_SHADOW_CANDIDATE', promotionEligible: false });
  });

  it('Given an agreeing mock pair, When CLI compares it, Then promotion PASS is neither printed nor exited', async () => {
    // Given
    const inputs = new Map([
      ['local.json', JSON.stringify(observation('local'))],
      ['remote.json', JSON.stringify(observation('remote'))],
    ]);
    const output: string[] = [];
    // When
    const code = await runRemoteShadowCli(
      ['--local', 'local.json', '--remote', 'remote.json', '--now', NOW.toISOString(), '--max-age-ms', '60000'],
      { write: (line) => output.push(line), readText: async (path) => inputs.get(path) ?? '' },
    );
    // Then
    expect(code).toBe(2);
    expect(output.join('\n')).toContain('REMOTE_SHADOW_CANDIDATE');
    expect(output.join('\n')).not.toContain('REMOTE_SHADOW_PASS');
    expect(output.join('\n')).not.toContain('customer-secret');
  });
});
