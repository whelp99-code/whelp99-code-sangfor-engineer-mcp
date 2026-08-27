import type {
  BrowserExecutionResult,
  JobEnvelope,
  LeafCertificate,
  RemoteJobDispatch,
  RemoteJobIndeterminateSeal,
  RemoteJobReservation,
  RemoteJobRetention,
} from '@sangfor/browser-contracts';

export type BlroDispatchPurpose = 'mutation' | 'verification';
export type BlroDispatchTarget = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly clientIdentityId: string;
  readonly deviceBindingDigest: string;
  readonly origin: string;
  readonly certificate: LeafCertificate;
  readonly endpointUrl: string;
  readonly environment: 'lab' | 'poc' | 'production';
};
export type BlroTargetAuthorizationInput = { readonly target: BlroDispatchTarget };
export type BlroAuthorityJobInput = {
  readonly envelope: JobEnvelope;
  readonly certificate: LeafCertificate;
};
export type BlroDispatchCandidate = {
  readonly kind: 'candidate';
  readonly claim: {
    readonly jti: string;
    readonly clientIdentityId: string;
    readonly installationId: string;
    readonly authorityEpoch: number;
  };
};
export interface BlroDispatchAuthority {
  authorizeTarget(input: BlroTargetAuthorizationInput): Promise<boolean>;
  classify(input: BlroAuthorityJobInput): Promise<RemoteJobReservation | BlroDispatchCandidate>;
  reserve(input: BlroAuthorityJobInput): Promise<RemoteJobReservation>;
  retainResult(input: {
    readonly dispatch: RemoteJobDispatch;
    readonly result: BrowserExecutionResult;
  }): Promise<RemoteJobRetention>;
  markIndeterminate(input: {
    readonly dispatch: RemoteJobDispatch;
  }): Promise<RemoteJobIndeterminateSeal>;
}
export type BlroJmDispatchInput = {
  readonly target: BlroDispatchTarget;
  readonly envelope: JobEnvelope;
  readonly receipt: string;
  readonly receiptId: string;
};
export type BlroJmDispatchOutcome =
  | { readonly kind: 'response'; readonly result: BrowserExecutionResult }
  | { readonly kind: 'predispatch_refused' }
  | { readonly kind: 'indeterminate' };
export interface BlroJmTransport {
  preflight(target: BlroDispatchTarget): Promise<boolean>;
  dispatch(input: BlroJmDispatchInput): Promise<BlroJmDispatchOutcome>;
}
export type BlroExecutionPolicy = {
  readonly allowRealExecution: boolean;
  readonly allowProductionExecution: boolean;
};
export type BlroReceiptSigner = {
  readonly sign: (artifact: Readonly<Record<string, unknown>>) => string;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly clientCertificateFingerprintSha256: string;
  readonly now: () => Date;
  readonly receiptId?: () => string;
};
export type BlroRemoteDispatcherOptions = {
  readonly authority: BlroDispatchAuthority;
  readonly transport: BlroJmTransport;
  readonly executionPolicy: BlroExecutionPolicy;
  readonly receiptSigner: BlroReceiptSigner;
};
export type BlroRemoteSubmission = {
  readonly purpose: BlroDispatchPurpose;
  readonly bodyText: string;
  readonly target: BlroDispatchTarget;
};
