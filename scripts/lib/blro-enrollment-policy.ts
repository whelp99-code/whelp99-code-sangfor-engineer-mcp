import {
  negotiateContractVersion,
  type ContractVersion,
} from '../../packages/sangfor-browser-contracts/src/protocol-version.js';

export const ADMIN_SCHEMA_VERSION = 'blro-enrollment-admin.v1' as const;
export const ROTATION_OVERLAP_LIMIT_SECONDS = 600;
export const REVOCATION_FRESHNESS_LIMIT_SECONDS = 60;

type AdminResult = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof ADMIN_SCHEMA_VERSION;
  readonly status: 'PASS' | 'REFUSED' | 'CONTAINED' | 'INCIDENT' | 'RECONCILED';
  readonly execution: 'DRY_RUN' | 'READ_ONLY' | 'NOT_RUN';
};

const result = (
  status: AdminResult['status'],
  execution: AdminResult['execution'],
  fields: Readonly<Record<string, unknown>>,
): AdminResult => ({ schemaVersion: ADMIN_SCHEMA_VERSION, status, execution, ...fields });

export function assessInstallationIdentity(input: {
  readonly installationId: string;
  readonly identityCount: number;
  readonly apply: boolean;
}): AdminResult {
  if (input.identityCount !== 1) {
    return result('REFUSED', 'NOT_RUN', {
      operation: 'identity', reason: 'INSTALLATION_IDENTITY_COUNT_INVALID', installationId: input.installationId,
    });
  }
  if (input.apply) return authorityRequired('identity', input.installationId);
  return result('PASS', 'READ_ONLY', {
    operation: 'identity', installationId: input.installationId, identityCount: input.identityCount,
  });
}

export function assessRotation(input: {
  readonly installationId: string;
  readonly identityCount: number;
  readonly overlapSeconds: number;
  readonly apply: boolean;
}): AdminResult {
  if (input.identityCount !== 1
    || input.overlapSeconds <= 0
    || input.overlapSeconds > ROTATION_OVERLAP_LIMIT_SECONDS) {
    return result('REFUSED', 'NOT_RUN', {
      operation: 'rotation', reason: 'INSTALLATION_IDENTITY_OR_OVERLAP_INVALID',
      installationId: input.installationId,
    });
  }
  if (input.apply) return authorityRequired('rotation', input.installationId);
  return result('PASS', 'DRY_RUN', {
    operation: 'rotation', installationId: input.installationId,
    overlapSeconds: input.overlapSeconds, maxOverlapSeconds: ROTATION_OVERLAP_LIMIT_SECONDS,
    nextStep: 'POST /api/enrollments/:installationId/rotate through the existing loopback authority',
  });
}

export function assessRevocation(input: {
  readonly installationId: string;
  readonly observationAgeSeconds: number;
  readonly apply: boolean;
}): AdminResult {
  if (input.observationAgeSeconds > REVOCATION_FRESHNESS_LIMIT_SECONDS) {
    return result('REFUSED', 'NOT_RUN', {
      operation: 'revocation', reason: 'REVOCATION_FRESHNESS_EXCEEDED',
      installationId: input.installationId, maxFreshnessSeconds: REVOCATION_FRESHNESS_LIMIT_SECONDS,
    });
  }
  if (input.apply) return authorityRequired('revocation', input.installationId);
  return result('PASS', 'READ_ONLY', {
    operation: 'revocation', installationId: input.installationId,
    freshnessSeconds: input.observationAgeSeconds,
    nextStep: 'POST /api/enrollments/:installationId/revoke through the existing loopback authority',
  });
}

export function assessRollout(input: {
  readonly blroVersion: ContractVersion;
  readonly jmVersion: ContractVersion;
  readonly blroReady: boolean;
}): AdminResult {
  if (!input.blroReady) {
    return result('REFUSED', 'NOT_RUN', { operation: 'rollout', reason: 'BLRO_NOT_READY' });
  }
  const decision = negotiateContractVersion(input.jmVersion, input.blroVersion);
  switch (decision.kind) {
    case 'supported':
      return result('PASS', 'READ_ONLY', {
        operation: 'rollout', rolloutOrder: ['BLRO', 'JM'],
        blroVersion: `${input.blroVersion.major}.${input.blroVersion.minor}`,
        jmVersion: `${decision.peer.major}.${decision.peer.minor}`,
      });
    case 'unsupported':
      return result('REFUSED', 'NOT_RUN', {
        operation: 'rollout', reason: decision.reason, rolloutOrder: ['BLRO', 'JM'],
      });
    default:
      return assertNever(decision);
  }
}

export function assessReadiness(input: {
  readonly blroReady: boolean;
  readonly writesContained: boolean;
}): AdminResult {
  if (!input.writesContained) {
    return result('REFUSED', 'NOT_RUN', { operation: 'readiness', reason: 'WRITES_NOT_CONTAINED' });
  }
  if (!input.blroReady) {
    return result('REFUSED', 'NOT_RUN', { operation: 'readiness', reason: 'BLRO_NOT_READY' });
  }
  return result('PASS', 'READ_ONLY', { operation: 'readiness', writesContained: true });
}

export function containEmergency(incidentId: string): AdminResult {
  return result('CONTAINED', 'NOT_RUN', {
    operation: 'emergency', incidentId, containment: 'OPERATOR_REQUIRED', writesContained: false,
    keyGeneration: 'EXTERNAL_CEREMONY_REQUIRED', caAction: 'REVOKE_AND_REISSUE_OUTSIDE_THIS_TOOL',
    privateMaterialAccepted: false,
  });
}

export function assessIncident(input: {
  readonly operation: 'incident' | 'reconcile';
  readonly jobId: string;
  readonly dispatchState: 'PREDISPATCH' | 'INDETERMINATE';
  readonly mutationAttempted: boolean;
  readonly readBack?: 'PASS' | 'FAIL' | 'INDETERMINATE';
}): AdminResult {
  if (input.dispatchState === 'PREDISPATCH' && !input.mutationAttempted) {
    return result('PASS', 'READ_ONLY', {
      operation: input.operation, jobId: input.jobId, retryAllowed: true, nonceResetAllowed: false,
    });
  }
  if (input.operation === 'reconcile' && input.readBack && input.readBack !== 'INDETERMINATE') {
    return result('RECONCILED', 'NOT_RUN', {
      operation: input.operation, jobId: input.jobId, resolution: `READ_BACK_${input.readBack}`,
      retryAllowed: false, nonceResetAllowed: false,
    });
  }
  return result(input.operation === 'incident' ? 'INCIDENT' : 'REFUSED', 'NOT_RUN', {
    operation: input.operation, jobId: input.jobId,
    reason: input.operation === 'incident'
      ? 'POST_DISPATCH_OUTCOME_UNKNOWN'
      : 'INDETERMINATE_REQUIRES_HUMAN_READ_BACK',
    retryAllowed: false, nonceResetAllowed: false, preserveTombstone: true,
  });
}

function authorityRequired(operation: string, installationId: string): AdminResult {
  return result('REFUSED', 'NOT_RUN', {
    operation, installationId, reason: 'EXISTING_AUTHORITY_REQUIRED',
    authority: 'Control Tower loopback enrollment API',
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled enrollment administration variant: ${JSON.stringify(value)}`);
}
