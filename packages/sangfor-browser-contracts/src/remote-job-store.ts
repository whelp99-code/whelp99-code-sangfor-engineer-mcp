import type {
  BrowserExecutionResult,
} from './browser-execution.js';
import type { LeafCertificate } from './enrollment.js';
import type { JobEnvelope } from './job-envelope.js';

export const REMOTE_JOB_REFUSAL_REASONS = {
  AUTHORIZATION_REFUSED: 'AUTHORIZATION_REFUSED',
  REQUEST_CONFLICT: 'REQUEST_CONFLICT',
} as const;

export type RemoteJobRefusalReason =
  (typeof REMOTE_JOB_REFUSAL_REASONS)[keyof typeof REMOTE_JOB_REFUSAL_REASONS];

export type RemoteJobDispatch = {
  readonly dispatchId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly authorityEpoch: number;
  readonly installationId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly capabilityJti: string;
};

export type RemoteJobReservation =
  | { readonly kind: 'dispatch'; readonly dispatch: RemoteJobDispatch }
  | { readonly kind: 'retained'; readonly result: BrowserExecutionResult }
  | { readonly kind: 'indeterminate'; readonly requestId: string }
  | { readonly kind: 'refused'; readonly reason: RemoteJobRefusalReason }
  | { readonly kind: 'unavailable' };

export type RemoteJobRetention =
  | { readonly kind: 'retained'; readonly result: BrowserExecutionResult }
  | { readonly kind: 'indeterminate' };

export type RemoteJobIndeterminateSeal =
  | { readonly kind: 'sealed' }
  | { readonly kind: 'unknown' };

export type RemoteJobReserveInput = {
  readonly envelope: JobEnvelope;
  readonly certificate: LeafCertificate | undefined;
};

export type RemoteJobRetainInput = {
  readonly dispatch: RemoteJobDispatch;
  readonly result: BrowserExecutionResult;
};

export type RemoteJobSealInput = {
  readonly dispatch: RemoteJobDispatch;
};

export interface RemoteJobStore {
  authorizeAndReserve(input: RemoteJobReserveInput): Promise<RemoteJobReservation>;
  retainResult(input: RemoteJobRetainInput): Promise<RemoteJobRetention>;
  markIndeterminate(input: RemoteJobSealInput): Promise<RemoteJobIndeterminateSeal>;
}
