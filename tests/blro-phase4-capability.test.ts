import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mintJobCapability,
  verifyAndConsumeJobCapability,
  type CapabilityNonceStore,
} from '../packages/sangfor-browser-contracts/src/capability.js';
import type {
  BrowserExecutionRequest,
  JobEnvelope,
} from '../packages/sangfor-browser-contracts/src/index.js';

const NOW = new Date('2026-08-13T00:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const otherKeyPair = generateKeyPairSync('ed25519');
const privateKey = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const otherPublicKey = otherKeyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const request: BrowserExecutionRequest = {
  schemaVersion: 'browser-execution-request.v1',
  requestId: 'request-a',
  sessionId: 'session-a',
  origin: 'https://jm.example.test',
  operation: {
    kind: 'capture_console_evidence',
    captureId: 'capture-a',
    menuPath: [{ menu: 'Status' }],
  },
};

class MemoryNonceStore implements CapabilityNonceStore {
  readonly consumed: string[] = [];

  async consume(jti: string): Promise<boolean> {
    if (this.consumed.includes(jti)) return false;
    this.consumed.push(jti);
    return true;
  }
}

function mint(
  requestOverride: BrowserExecutionRequest = request,
  overrides: Partial<Parameters<typeof mintJobCapability>[0]> = {},
): string {
  return mintJobCapability({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    runId: 'run-a',
    stepId: 'step-a',
    jobId: 'job-a',
    clientIdentityId: 'client:install-a',
    installationId: 'install-a',
    request: requestOverride,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    jti: 'capability-a',
    privateKey,
    ...overrides,

  authorityEpoch: 0,});
}

function envelope(
  token = mint(),
  requestOverride: BrowserExecutionRequest = request,
): JobEnvelope {
  return {
    schemaVersion: 'browser-job-envelope.v1',
    jobId: 'job-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    runId: 'run-a',
    stepId: 'step-a',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    capability: token,
    request: requestOverride,
  };
}

function verifyInput(
  nonceStore: CapabilityNonceStore,
  overrides: Partial<Parameters<typeof verifyAndConsumeJobCapability>[0]> = {},
): Parameters<typeof verifyAndConsumeJobCapability>[0] {
  return {
    envelope: envelope(),
    installationId: 'install-a',
    clientIdentityId: 'client:install-a',
    publicKey,
    nonceStore,
    now: new Date(NOW.getTime() + 1_000),
    ...overrides,
  };
}

describe('Phase 4 asymmetric job capability', () => {
  it('accepts exactly once with only the verify public key at JM', async () => {
    const nonceStore = new MemoryNonceStore();
    const input = verifyInput(nonceStore);

    await expect(verifyAndConsumeJobCapability(input)).resolves.toMatchObject({
      jti: 'capability-a',
      jobId: 'job-a',
      installationId: 'install-a',
    });
    await expect(verifyAndConsumeJobCapability(input))
      .rejects.toThrow('CAPABILITY_REPLAYED');
  });

  it.each([
    ['expired', { now: new Date(NOW.getTime() + 60_000) }, 'CAPABILITY_EXPIRED'],
    ['not yet valid', { now: new Date(NOW.getTime() - 1) }, 'CAPABILITY_NOT_YET_VALID'],
    ['wrong installation', { installationId: 'install-b' }, 'CAPABILITY_IDENTITY_MISMATCH'],
    ['wrong client', { clientIdentityId: 'client:install-b' }, 'CAPABILITY_IDENTITY_MISMATCH'],
    ['wrong signing key', { publicKey: otherPublicKey }, 'CAPABILITY_SIGNATURE_INVALID'],
  ])('refuses %s before single-use consumption', async (_name, override, reason) => {
    const nonceStore = new MemoryNonceStore();
    await expect(verifyAndConsumeJobCapability(verifyInput(
      nonceStore,
      override as Partial<Parameters<typeof verifyAndConsumeJobCapability>[0]>,
    ))).rejects.toThrow(reason);
    expect(nonceStore.consumed).toEqual([]);
  });

  it.each([
    ['tenant', { tenantId: 'tenant-b' }],
    ['project', { projectId: 'project-b' }],
    ['run', { runId: 'run-b' }],
    ['step', { stepId: 'step-b' }],
    ['job', { jobId: 'job-b' }],
  ])('refuses wrong %s envelope binding', async (_name, changed) => {
    const nonceStore = new MemoryNonceStore();
    await expect(verifyAndConsumeJobCapability(verifyInput(nonceStore, {
      envelope: { ...envelope(), ...changed },
    }))).rejects.toThrow('CAPABILITY_SCOPE_MISMATCH');
    expect(nonceStore.consumed).toEqual([]);
  });

  it.each([
    ['request id', { ...request, requestId: 'request-b' }],
    ['session id', { ...request, sessionId: 'session-b' }],
    ['origin', { ...request, origin: 'https://other.example.test' }],
    [
      'operation',
      {
        ...request,
        operation: { ...request.operation, captureId: 'capture-b' },
      },
    ],
  ])('binds the full request, including %s', async (_name, changedRequest) => {
    const nonceStore = new MemoryNonceStore();
    await expect(verifyAndConsumeJobCapability(verifyInput(nonceStore, {
      envelope: envelope(mint(), changedRequest as BrowserExecutionRequest),
    }))).rejects.toThrow('CAPABILITY_ACTION_MISMATCH');
    expect(nonceStore.consumed).toEqual([]);
  });

  it('refuses token tampering before nonce consumption', async () => {
    const nonceStore = new MemoryNonceStore();
    const token = mint();
    const [payload, signature] = token.split('.');
    const changedSignature = `${signature?.[0] === 'A' ? 'B' : 'A'}${signature?.slice(1)}`;
    await expect(verifyAndConsumeJobCapability(verifyInput(nonceStore, {
      envelope: envelope(`${payload}.${changedSignature}`),
    }))).rejects.toThrow('CAPABILITY_SIGNATURE_INVALID');
    expect(nonceStore.consumed).toEqual([]);
  });
});
