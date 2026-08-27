import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  browserExecutionRequestDigest,
  browserExecutionResultSchema,
  deriveReservationDigest,
  indeterminateAfterDispatch,
  isLoopbackBrowserTarget,
  maskSensitiveMetadataText,
  parseJobEnvelope,
  refusedResult,
  type BrowserExecutionResult,
  type JobEnvelope,
  type RemoteJobDispatch,
  type RemoteJobReservation,
} from '@sangfor/browser-contracts';
import type {
  BlroDispatchCandidate,
  BlroDispatchPurpose,
  BlroDispatchTarget,
  BlroExecutionPolicy,
  BlroRemoteDispatcherOptions,
  BlroRemoteSubmission,
} from './blro-remote-dispatcher-contracts.js';
export type * from './blro-remote-dispatcher-contracts.js';

export function createBlroRemoteDispatcher(options: BlroRemoteDispatcherOptions) {
  return {
    async submit(input: BlroRemoteSubmission): Promise<BrowserExecutionResult> {
      if (!executionAllowed(input, options.executionPolicy)) return refusal('EXECUTION_GATE_REFUSED');
      if (!await options.authority.authorizeTarget({ target: input.target })) {
        return refusal('TARGET_AUTHORIZATION_REFUSED');
      }
      const envelope = parseEnvelope(input.bodyText, options.receiptSigner.now());
      if (!envelope) return refusal('ENVELOPE_INVALID');
      if (!matchesTarget(envelope, input.target) || !matchesPurpose(envelope, input.purpose)) {
        return refusedResult(envelope.request.requestId, 'REQUEST_BINDING_REFUSED', 'Remote request binding was refused.');
      }
      const authorityInput = { envelope, certificate: input.target.certificate };
      const classification = await options.authority.classify(authorityInput);
      if (classification.kind !== 'candidate') {
        return resultFromReservation(classification, input.purpose, envelope.request.requestId);
      }
      if (classification.claim.installationId !== input.target.installationId
        || classification.claim.clientIdentityId !== input.target.clientIdentityId) {
        return refusedResult(envelope.request.requestId, 'CAPABILITY_IDENTITY_REFUSED', 'Capability identity was refused.');
      }
      if (!await options.transport.preflight(input.target)) {
        return refusedResult(envelope.request.requestId, 'JM_PREFLIGHT_UNAVAILABLE', 'JM read-only preflight is unavailable.');
      }
      const reservation = await options.authority.reserve(authorityInput);
      if (reservation.kind !== 'dispatch') {
        const settled = reservation.kind === 'indeterminate'
          ? await options.authority.classify(authorityInput)
          : reservation;
        return resultFromReservation(settled.kind === 'candidate'
          ? reservation
          : settled, input.purpose, envelope.request.requestId);
      }
      return dispatchReserved(options, input, envelope, classification, reservation.dispatch);
    },
  };
}

async function dispatchReserved(
  options: BlroRemoteDispatcherOptions,
  submission: BlroRemoteSubmission,
  envelope: JobEnvelope,
  candidate: BlroDispatchCandidate,
  dispatch: RemoteJobDispatch,
): Promise<BrowserExecutionResult> {
  const receiptId = options.receiptSigner.receiptId?.() ?? `receipt-${randomUUID()}`;
  const now = options.receiptSigner.now();
  const capabilityDigest = digest(envelope.capability);
  const requestDigest = browserExecutionRequestDigest(envelope.request);
  const artifact = {
    version: 'blro-authority-receipt.v1', receiptId,
    tenantId: dispatch.tenantId, projectId: dispatch.projectId,
    installationId: dispatch.installationId,
    deviceBindingDigest: submission.target.deviceBindingDigest,
    origin: envelope.request.origin, authorityEpoch: dispatch.authorityEpoch,
    jobId: dispatch.jobId, requestId: dispatch.requestId,
    capabilityJti: candidate.claim.jti, requestDigest, capabilityDigest,
    capabilityVerifyKeyId: options.receiptSigner.keyId,
    capabilityVerifyKeyDigest: options.receiptSigner.keyDigest,
    clientCertificateFingerprintSha256: options.receiptSigner.clientCertificateFingerprintSha256,
    reservationDigest: deriveReservationDigest({
      tenantId: dispatch.tenantId, projectId: dispatch.projectId,
      installationId: dispatch.installationId,
      deviceBindingDigest: submission.target.deviceBindingDigest,
      authorityEpoch: dispatch.authorityEpoch, jobId: dispatch.jobId,
      requestId: dispatch.requestId, capabilityJti: candidate.claim.jti,
      requestDigest, capabilityDigest,
    }),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  } as const;
  await options.lifecycleObserver?.dispatchBoundary(dispatch);
  const outcome = await options.transport.dispatch({
    target: submission.target, envelope,
    receipt: options.receiptSigner.sign(artifact), receiptId,
  });
  switch (outcome.kind) {
    case 'predispatch_refused': {
      const refused = refusedResult(dispatch.requestId, 'JM_PREDISPATCH_REFUSED', 'JM refused before dispatch.');
      await options.authority.retainResult({ dispatch, result: refused });
      return refused;
    }
    case 'indeterminate':
      await options.authority.markIndeterminate({ dispatch });
      return indeterminateAfterDispatch(dispatch.requestId, 'JM dispatch acknowledgement is unavailable.');
    case 'response': {
      const masked = maskResult(outcome.result);
      const retained = await options.authority.retainResult({ dispatch, result: masked });
      if (retained.kind !== 'retained') {
        return indeterminateAfterDispatch(dispatch.requestId, 'JM result retention is unavailable.');
      }
      await options.lifecycleObserver?.resultRetained(dispatch);
      return finalVerdict(submission.purpose, retained.result);
    }
    default:
      return assertNever(outcome);
  }
}

function resultFromReservation(
  reservation: RemoteJobReservation,
  purpose: BlroDispatchPurpose,
  requestId: string,
): BrowserExecutionResult {
  switch (reservation.kind) {
    case 'retained': return finalVerdict(purpose, maskResult(reservation.result));
    case 'indeterminate': return indeterminateAfterDispatch(reservation.requestId, 'Dispatch state remains indeterminate.');
    case 'refused': return refusedResult(requestId, 'REMOTE_JOB_REFUSED', 'Remote job authority refused the request.');
    case 'unavailable': return refusedResult(requestId, 'REMOTE_JOB_AUTHORITY_UNAVAILABLE', 'Remote job authority is unavailable.');
    case 'dispatch': return indeterminateAfterDispatch(requestId, 'Unexpected dispatch classification.');
    default: return assertNever(reservation);
  }
}

function finalVerdict(purpose: BlroDispatchPurpose, observed: BrowserExecutionResult): BrowserExecutionResult {
  if (purpose === 'mutation') {
    return observed.status === 'REFUSED' && !observed.mutationAttempted
      ? observed
      : indeterminateAfterDispatch(observed.requestId, 'Mutation responses are observational and never authoritative PASS.');
  }
  return observed.status === 'PASS' && observed.readBack?.status === 'PASS' && !observed.mutationAttempted
    ? observed
    : observed.status === 'PASS'
      ? { ...observed, status: 'INDETERMINATE', readBack: { status: 'INDETERMINATE' } }
      : observed;
}

function executionAllowed(input: BlroRemoteSubmission, policy: BlroExecutionPolicy): boolean {
  if (!policy.allowRealExecution) return false;
  return input.target.environment !== 'production'
    && isLoopbackBrowserTarget(input.target.origin)
    ? true
    : policy.allowProductionExecution;
}

function parseEnvelope(bodyText: string, now: Date): JobEnvelope | undefined {
  try {
    const value: unknown = JSON.parse(bodyText);
    return parseJobEnvelope(value, now);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) return undefined;
    throw error;
  }
}

function matchesTarget(envelope: JobEnvelope, target: BlroDispatchTarget): boolean {
  return envelope.tenantId === target.tenantId
    && envelope.projectId === target.projectId
    && envelope.request.origin === target.origin;
}

function matchesPurpose(envelope: JobEnvelope, purpose: BlroDispatchPurpose): boolean {
  switch (purpose) {
    case 'mutation':
      return envelope.request.operation.kind === 'perform_console_action'
        && envelope.request.operation.action.dryRun === false;
    case 'verification':
      return envelope.request.operation.kind === 'verify_console';
    default:
      return assertNever(purpose);
  }
}

function maskResult(result: BrowserExecutionResult): BrowserExecutionResult {
  const masked = maskValue(result);
  return browserExecutionResultSchema.parse(masked);
}

function maskValue(value: unknown, key = ''): unknown {
  if (/password|secret|token|authorization|cookie|session(?:id)?|api[_-]?key/iu.test(key)) return '***';
  if (typeof value === 'string') return maskSensitiveMetadataText(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, maskValue(child, childKey)]));
  }
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function refusal(code: string): BrowserExecutionResult {
  return refusedResult('unknown-request', code, 'Remote dispatch was refused.');
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled BLRO dispatch variant: ${JSON.stringify(value)}`);
}
