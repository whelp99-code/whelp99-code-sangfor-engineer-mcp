import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import {
  browserExecutionRequestDigest,
  deriveReservationDigest,
  mintJobCapability,
  type BrowserExecutionRequest,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import { signJmAuthorityArtifact } from '../../packages/sangfor-authority/src/index.js';
import {
  publicKeyDigest,
  type AuthorityReceipt,
  type GrantSnapshot,
} from '../../packages/sangfor-jm-agent/src/index.js';
import {
  JM_CLIENT_IDENTITY_ID,
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  originDigest,
} from './jm-agent-identity.js';
import { CURRENT_KEY_ID, type JmSigningMaterial } from './jm-agent-signing-material.js';

export type SnapshotOverrides = {
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
  readonly state?: 'active' | 'revoked';
  readonly authorityEpoch?: number;
  readonly scopes?: readonly string[];
  readonly originDigests?: readonly string[];
  readonly journalGenesis?: string;
  readonly deviceBindingDigest?: string;
  readonly privateKey?: KeyObject;
};

/** BLRO-side minting; JM only ever verifies these bytes. */
export function buildGrantSnapshot(
  material: JmSigningMaterial,
  overrides: SnapshotOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ?? new Date();
  const snapshot: GrantSnapshot = {
    version: 'blro-enrollment-grant-snapshot.v1',
    snapshotId: `snap-${randomUUID()}`,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    clientIdentityId: JM_CLIENT_IDENTITY_ID,
    deviceBindingDigest: overrides.deviceBindingDigest ?? JM_DEVICE_DIGEST,
    authorityEpoch: overrides.authorityEpoch ?? 7,
    state: overrides.state ?? 'active',
    grants: (overrides.originDigests ?? [originDigest(JM_ORIGIN)])
      .flatMap((digest) => (overrides.scopes ?? ['browser:execute'])
        .map((scope) => ({ originDigest: digest, scope }))),
    journalGenesis: overrides.journalGenesis ?? JM_JOURNAL_GENESIS,
    issuedAt: issuedAt.toISOString(),
    expiresAt: (overrides.expiresAt ?? new Date(issuedAt.getTime() + 86_400_000)).toISOString(),
  };
  return signJmAuthorityArtifact(snapshot, overrides.privateKey ?? material.currentPrivateKey);
}

export type ReceiptOverrides = Partial<AuthorityReceipt> & {
  readonly privateKey?: KeyObject;
  /** Forces a reservationDigest that does not match the derived identity. */
  readonly breakReservation?: boolean;
};

/** The one exact dispatch a receipt is bound to. */
type ReceiptBinding = {
  readonly request: BrowserExecutionRequest;
  readonly jobId: string;
  readonly capability: string;
  readonly capabilityJti: string;
  readonly clientFingerprint: string;
};

/** BLRO-side minting of a per-dispatch receipt bound to one exact request. */
export function buildAuthorityReceipt(
  material: JmSigningMaterial,
  binding: ReceiptBinding,
  overrides: ReceiptOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ? new Date(overrides.issuedAt) : new Date();
  const receipt: AuthorityReceipt = {
    version: 'blro-authority-receipt.v1',
    receiptId: `receipt-${randomUUID()}`,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    deviceBindingDigest: JM_DEVICE_DIGEST,
    origin: JM_ORIGIN,
    authorityEpoch: 7,
    jobId: binding.jobId,
    requestId: binding.request.requestId,
    capabilityJti: binding.capabilityJti,
    requestDigest: browserExecutionRequestDigest(binding.request),
    capabilityDigest: createHash('sha256').update(binding.capability, 'utf8').digest('hex'),
    capabilityVerifyKeyId: CURRENT_KEY_ID,
    capabilityVerifyKeyDigest: publicKeyDigest(material.currentPublicKeyPem),
    clientCertificateFingerprintSha256: binding.clientFingerprint,
    // Derived with the SHARED contract function, exactly as JM will re-derive it.
    reservationDigest: deriveReservationDigest({
      tenantId: JM_TENANT_ID,
      projectId: JM_PROJECT_ID,
      installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST,
      authorityEpoch: 7,
      jobId: binding.jobId,
      requestId: binding.request.requestId,
      capabilityJti: binding.capabilityJti,
      requestDigest: browserExecutionRequestDigest(binding.request),
      capabilityDigest: createHash('sha256').update(binding.capability, 'utf8').digest('hex'),
    }),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 600_000).toISOString(),
    ...overrides,
  };
  const { privateKey, breakReservation, ...merged } = { ...receipt, ...overrides };
  const claim = breakReservation === true
    ? { ...merged, reservationDigest: createHash('sha256').update('wrong').digest('hex') }
    : merged;
  return signJmAuthorityArtifact(claim, overrides.privateKey ?? material.currentPrivateKey);
}

export function browserRequest(
  overrides: Partial<BrowserExecutionRequest> = {},
): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `req-${randomUUID()}`,
    sessionId: JM_SESSION_ID,
    origin: JM_ORIGIN,
    operation: { kind: 'observe_console', includeSnapshot: false },
    ...overrides,
  } as BrowserExecutionRequest;
}

export type CapabilityOverrides = {
  readonly jti?: string;
  readonly authorityEpoch?: number;
  readonly expiresAt?: Date;
  readonly issuedAt?: Date;
  readonly jobId?: string;
  readonly privateKey?: KeyObject;
};

export function mintTaskCapability(
  material: JmSigningMaterial,
  request: BrowserExecutionRequest,
  overrides: CapabilityOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ?? new Date();
  return mintJobCapability({
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    authorityEpoch: overrides.authorityEpoch ?? 7,
    runId: request.sessionId,
    stepId: request.requestId,
    jobId: overrides.jobId ?? request.requestId,
    clientIdentityId: JM_CLIENT_IDENTITY_ID,
    installationId: JM_INSTALLATION_ID,
    request,
    issuedAt,
    expiresAt: overrides.expiresAt ?? new Date(issuedAt.getTime() + 60_000),
    jti: overrides.jti ?? `jti-${randomUUID()}`,
    privateKey: overrides.privateKey ?? material.currentPrivateKey,
  });
}
