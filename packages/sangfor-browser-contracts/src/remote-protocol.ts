import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from './browser-execution.js';
import { jobEnvelopeSchema, type JobEnvelope } from './job-envelope.js';

export const REMOTE_BROWSER_JOB_PATH = '/v1/browser-jobs' as const;
export const REMOTE_TRANSPORT_ERROR_CODES = {
  SERVER_IDENTITY_MISMATCH: 'REMOTE_SERVER_IDENTITY_MISMATCH',
  CLIENT_UNAUTHORIZED: 'REMOTE_CLIENT_UNAUTHORIZED',
  JOB_AUTHORIZATION_DENIED: 'REMOTE_JOB_AUTHORIZATION_DENIED',
  TRANSPORT_UNAVAILABLE: 'REMOTE_TRANSPORT_UNAVAILABLE',
  DISCONNECT_AFTER_DISPATCH: 'REMOTE_TRANSPORT_DISCONNECT',
  BAD_RESPONSE: 'REMOTE_TRANSPORT_BAD_RESPONSE',
  BAD_ENVELOPE: 'REMOTE_JOB_ENVELOPE_INVALID',
  PATH_NOT_FOUND: 'REMOTE_PATH_NOT_FOUND',
  METHOD_NOT_ALLOWED: 'REMOTE_METHOD_NOT_ALLOWED',
} as const;

const DEFAULT_JOB_TTL_MS = 60_000;

export interface RemoteEnvelopeOptions {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId?: string | ((request: BrowserExecutionRequest) => string);
  readonly stepId?: string | ((request: BrowserExecutionRequest) => string);
  readonly jobId?: (request: BrowserExecutionRequest) => string;
  readonly capability:
    | string
    | ((input: {
      readonly request: BrowserExecutionRequest;
      readonly runId: string;
      readonly stepId: string;
      readonly jobId: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    }) => string);
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface RemotePeerIdentity {
  readonly fingerprint256: string;
  readonly subjectCN?: string;
  readonly tlsAuthorized: boolean;
  readonly raw: object;
}

export interface RemoteHandlerResponse {
  readonly statusCode: number;
  readonly bodyText: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function normalizeFingerprint256(fingerprint: string): string {
  return fingerprint.replaceAll(':', '').trim().toLowerCase();
}

export function fingerprintsMatch(left: string, right: string): boolean {
  return normalizeFingerprint256(left) === normalizeFingerprint256(right);
}

export function peerIdentityFromCertificate(
  certificate: {
    readonly fingerprint256?: string;
    readonly subject?: { readonly CN?: unknown };
  } | undefined,
  tlsAuthorized: boolean,
): RemotePeerIdentity | null {
  if (!certificate?.fingerprint256) return null;
  const subjectCN = typeof certificate.subject?.CN === 'string'
    ? certificate.subject.CN
    : undefined;
  return {
    fingerprint256: certificate.fingerprint256,
    ...(subjectCN ? { subjectCN } : {}),
    tlsAuthorized,
    raw: certificate,
  };
}

export function createExactServerIdentityChecker(
  expectedFingerprint256: string,
): (
  servername: string,
  certificate: { readonly fingerprint256?: string },
) => Error | undefined {
  const expected = normalizeFingerprint256(expectedFingerprint256);
  return (_servername, certificate) => {
    if (
      !certificate.fingerprint256
      || normalizeFingerprint256(certificate.fingerprint256) !== expected
    ) {
      return new Error(
        `${REMOTE_TRANSPORT_ERROR_CODES.SERVER_IDENTITY_MISMATCH}: `
        + 'server certificate fingerprint does not match the exact expected identity.',
      );
    }
    return undefined;
  };
}

export function buildRemoteJobEnvelope(
  input: BrowserExecutionRequest,
  options: RemoteEnvelopeOptions,
): JobEnvelope {
  const request = browserExecutionRequestSchema.parse(input);
  const issuedAt = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(issuedAt.getTime() + (options.ttlMs ?? DEFAULT_JOB_TTL_MS));
  const runId = typeof options.runId === 'function'
    ? options.runId(request)
    : (options.runId ?? request.sessionId);
  const stepId = typeof options.stepId === 'function'
    ? options.stepId(request)
    : (options.stepId ?? request.requestId);
  const jobId = options.jobId?.(request) ?? request.requestId;
  const capability = typeof options.capability === 'function'
    ? options.capability({ request, runId, stepId, jobId, issuedAt, expiresAt })
    : options.capability;
  return jobEnvelopeSchema.parse({
    schemaVersion: 'browser-job-envelope.v1',
    jobId,
    tenantId: options.tenantId,
    projectId: options.projectId,
    runId,
    stepId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    capability,
    request,
  });
}

export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return { 'content-type': 'application/json; charset=utf-8', ...extra };
}

export function errorBody(code: string, message: string): string {
  return JSON.stringify({
    schemaVersion: 'browser-remote-error.v1',
    error: { code, message },
  });
}

export function resultResponse(
  statusCode: number,
  result: BrowserExecutionResult,
): RemoteHandlerResponse {
  return { statusCode, bodyText: JSON.stringify(result), headers: jsonHeaders() };
}

export function refusedResult(
  requestId: string,
  code: string,
  message: string,
): BrowserExecutionResult {
  return browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'REFUSED',
    mutationAttempted: false,
    evidence: [],
    error: { code, message },
  });
}

export function indeterminateAfterDispatch(
  requestId: string,
  message: string,
): BrowserExecutionResult {
  return browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'INDETERMINATE',
    mutationAttempted: true,
    readBack: { status: 'INDETERMINATE' },
    observations: {},
    evidence: [],
    error: {
      code: REMOTE_TRANSPORT_ERROR_CODES.DISCONNECT_AFTER_DISPATCH,
      message,
      remediation:
        'Do not retry automatically. Inspect JM and device state, then perform human read-back.',
    },
  });
}
