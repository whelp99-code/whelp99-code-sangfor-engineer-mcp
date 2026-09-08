import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteJobStore } from '@sangfor/browser-contracts';
import type { JmExecutionPort } from './execution-port.js';
import { createBlroClientAuthorizer, type BlroClientPin } from './client-pin.js';
import type { JmAgentConfig } from './config-schema.js';
import {
  GRANT_SNAPSHOT_REFUSALS,
  verifyGrantSnapshot,
  decodeGrantSnapshotUnverified,
  type GrantSnapshot,
} from './grant-snapshot.js';
import { KeyRing } from './key-ring.js';
import { checkServerIdentity } from './server-identity.js';
import { JOURNAL_HEADER_KIND, RefusalJournal } from './refusal-journal.js';

/** The one file name production will open under the operator's journal root. */
export const JOURNAL_FILE_NAME = 'refusals.jsonl' as const;
import { createReceiptRemoteJobStore } from './receipt-job-store.js';
import {
  JM_READINESS_REASONS,
  failedCheck,
  livenessFrom,
  okCheck,
  readinessFrom,
  type JmLiveness,
  type JmLivenessState,
  type JmReadiness,
  type JmReadinessCheck,
} from './readiness.js';

export class JmRuntimeStartupError extends Error {
  override readonly name = 'JmRuntimeStartupError';
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type JmAgentRuntimeInput = {
  readonly config: JmAgentConfig;
  /** The operated execution seam; readiness calls its real preflight. */
  readonly executionPort: JmExecutionPort;
  readonly receiptFor: (jobId: string) => string | undefined;
  /** The receiptId BLRO announced out of band for this job. */
  readonly receiptIdFor: (jobId: string) => string | undefined;
  readonly clientFingerprintFor: (jobId: string) => string | undefined;
  readonly now?: () => Date;
};

export type JmAgentRuntime = {
  readonly jobStore: RemoteJobStore;
  readonly authorizeClient: ReturnType<typeof createBlroClientAuthorizer>;
  readonly journal: RefusalJournal;
  readiness(): JmReadiness;
  liveness(): JmLiveness;
  beginDrain(): void;
  markClosed(): void;
  markFailed(): void;
  readonly state: () => JmLivenessState;
};

/**
 * Builds the runtime after the STATIC gates pass. A correctly signed but stale
 * or revoked snapshot is deliberately NOT a startup failure: the process must
 * come up, serve /live, and report the condition through /ready.
 */
export function createJmAgentRuntime(input: JmAgentRuntimeInput): JmAgentRuntime {
  const clock = input.now ?? (() => new Date());
  const config = input.config;
  const keyRing = loadKeyRing(config);
  const encodedSnapshot = readText(config.grantSnapshotPath, 'GRANT_SNAPSHOT_UNREADABLE');
  const snapshotKey = keyRing.resolve(currentKeyId(config), clock());
  // Structural trust is a startup gate; freshness and revocation are not.
  const structural = verifyGrantSnapshot({
    snapshot: encodedSnapshot,
    publicKeyPem: snapshotKey.ok ? snapshotKey.entry.publicKeyPem : '',
    expected: {
      tenantId: config.tenantId,
      projectId: config.projectId,
      installationId: config.installationId,
    },
    now: clock(),
  });
  if (!structural.ok && !isDynamicSnapshotFault(structural.reason)) {
    throw new JmRuntimeStartupError(structural.reason);
  }
  const snapshot = structural.ok
    ? structural.snapshot
    : requireDecoded(encodedSnapshot);
  if (snapshot.deviceBindingDigest !== config.deviceBindingDigest) {
    throw new JmRuntimeStartupError('SNAPSHOT_DEVICE_MISMATCH');
  }
  // Production NEVER creates a journal. The operator must have initialised the
  // root and the file; anything else is a startup refusal.
  const journal = RefusalJournal.open({
    path: join(config.journalRoot, JOURNAL_FILE_NAME),
    expected: {
      kind: JOURNAL_HEADER_KIND,
      tenantId: config.tenantId,
      projectId: config.projectId,
      installationId: config.installationId,
      deviceBindingDigest: config.deviceBindingDigest,
      journalEpoch: snapshot.authorityEpoch,
      genesisDigest: snapshot.journalGenesis,
    },
  });

  let state: JmLivenessState = 'running';
  const jobStore = createReceiptRemoteJobStore({
    receiptFor: (reserve) => input.receiptFor(reserve.envelope.jobId),
    receiptIdFor: (reserve) => input.receiptIdFor(reserve.envelope.jobId),
    clientFingerprintFor: (reserve) => input.clientFingerprintFor(reserve.envelope.jobId),
    snapshot: () => snapshot,
    keyRing,
    journal,
    allowedOrigin: config.allowedOrigin,
    now: clock,
  });

  return {
    jobStore,
    journal,
    authorizeClient: createBlroClientAuthorizer(pinFrom(config)),
    readiness: (): JmReadiness => readinessFrom({
      config: okCheck,
      trust: trustCheck(config, clock()),
      capabilityVerifier: keyRing.hasUsableKey(clock())
        ? okCheck
        : failedCheck(JM_READINESS_REASONS.CAPABILITY_VERIFIER_INVALID),
      grantSnapshot: snapshotCheck(config, encodedSnapshot, keyRing, clock()),
      journal: journalCheck(journal),
      executionPreflight: preflightCheck(input.executionPort),
      drain: state === 'running' ? okCheck : failedCheck(JM_READINESS_REASONS.DRAINING),
    }),
    liveness: (): JmLiveness => livenessFrom(state),
    beginDrain: (): void => { if (state === 'running') state = 'draining'; },
    markClosed: (): void => { state = 'closed'; },
    markFailed: (): void => { state = 'failed'; },
    state: () => state,
  };
}

function isDynamicSnapshotFault(reason: string): boolean {
  return reason === GRANT_SNAPSHOT_REFUSALS.EXPIRED
    || reason === GRANT_SNAPSHOT_REFUSALS.REVOKED;
}

function requireDecoded(encoded: string): GrantSnapshot {
  const decoded = decodeGrantSnapshotUnverified(encoded);
  if (!decoded) throw new JmRuntimeStartupError(GRANT_SNAPSHOT_REFUSALS.FORMAT_INVALID);
  return decoded;
}

function currentKeyId(config: JmAgentConfig): string {
  const ring = readJson(config.verifyKeyRingPath);
  const keys = (ring as { readonly keys?: readonly { keyId: string; role: string }[] }).keys ?? [];
  return keys.find((entry) => entry.role === 'current')?.keyId ?? '';
}

function loadKeyRing(config: JmAgentConfig): KeyRing {
  const loaded = KeyRing.load(readJson(config.verifyKeyRingPath));
  if (!loaded.ok) throw new JmRuntimeStartupError(loaded.reason);
  return loaded.ring;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new JmRuntimeStartupError('KEY_RING_UNREADABLE');
  }
}

function readText(path: string, reason: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new JmRuntimeStartupError(reason);
  }
}

function pinFrom(config: JmAgentConfig): BlroClientPin {
  return {
    fingerprintSha256: config.blroClientFingerprintSha256,
    subjectCn: config.blroClientSubjectCn,
    serial: config.blroClientSerial,
    sanUri: config.blroClientSanUri,
    issuerCn: config.blroClientIssuerCn,
  };
}

function trustCheck(config: JmAgentConfig, now: Date): JmReadinessCheck {
  const identity = checkServerIdentity({
    certPath: config.tlsCertPath,
    keyPath: config.tlsKeyPath,
    caPath: config.tlsClientCaPath,
    now,
  });
  return identity.ok ? okCheck : failedCheck(JM_READINESS_REASONS.TRUST_INVALID);
}

function snapshotCheck(
  config: JmAgentConfig,
  encoded: string,
  keyRing: KeyRing,
  now: Date,
): JmReadinessCheck {
  const key = keyRing.resolve(currentKeyId(config), now);
  if (!key.ok) return failedCheck(JM_READINESS_REASONS.GRANT_SNAPSHOT_INVALID);
  const decision = verifyGrantSnapshot({
    snapshot: encoded,
    publicKeyPem: key.entry.publicKeyPem,
    expected: {
      tenantId: config.tenantId,
      projectId: config.projectId,
      installationId: config.installationId,
    },
    now,
  });
  if (!decision.ok) return failedCheck(JM_READINESS_REASONS.GRANT_SNAPSHOT_INVALID);
  const age = now.getTime() - Date.parse(decision.snapshot.issuedAt);
  return age > config.snapshotMaxAgeMs
    ? failedCheck(JM_READINESS_REASONS.GRANT_SNAPSHOT_INVALID)
    : okCheck;
}

/** A journal that can no longer be read is fail-closed, never fail-open. */
function journalCheck(journal: RefusalJournal): JmReadinessCheck {
  return journal.healthy()
    ? okCheck
    : failedCheck(JM_READINESS_REASONS.JOURNAL_UNAVAILABLE);
}

/**
 * Calls the REAL ongoing preflight; there is no hardcoded success. It never
 * rebinds the service port, which the running listener already holds.
 */
function preflightCheck(port: JmExecutionPort): JmReadinessCheck {
  try {
    return port.readinessPreflight().ok
      ? okCheck
      : failedCheck(JM_READINESS_REASONS.EXECUTION_PREFLIGHT_FAILED);
  } catch {
    return failedCheck(JM_READINESS_REASONS.EXECUTION_PREFLIGHT_FAILED);
  }
}
