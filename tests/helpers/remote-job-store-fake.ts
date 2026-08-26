import {
  REMOTE_JOB_REFUSAL_REASONS,
  browserExecutionRequestDigest,
  type BrowserExecutionResult,
  type RemoteJobReserveInput,
  type RemoteJobReservation,
  type RemoteJobRetainInput,
  type RemoteJobRetention,
  type RemoteJobSealInput,
  type RemoteJobStore,
} from '../../packages/sangfor-browser-contracts/src/index.js';

type FakeRemoteJobRecord = {
  readonly requestDigest: string;
  result?: BrowserExecutionResult;
  indeterminate: boolean;
};

/** Mutable in-memory state is confined to tests; production has no fallback. */
export class TestRemoteJobStore implements RemoteJobStore {
  readonly reserves: string[] = [];
  readonly retentions: string[] = [];
  private readonly records = new Map<string, FakeRemoteJobRecord>();
  private sequence = 0;

  async authorizeAndReserve(input: RemoteJobReserveInput): Promise<RemoteJobReservation> {
    this.reserves.push(input.envelope.jobId);
    const key = this.key(input);
    const requestDigest = browserExecutionRequestDigest(input.envelope.request);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT };
      }
      if (existing.result) return { kind: 'retained', result: existing.result };
      return { kind: 'indeterminate', requestId: input.envelope.request.requestId };
    }
    this.sequence += 1;
    this.records.set(key, { requestDigest, indeterminate: false });
    return {
      kind: 'dispatch',
      dispatch: {
        dispatchId: `test-dispatch-${this.sequence}`,
        tenantId: input.envelope.tenantId,
        projectId: input.envelope.projectId,
        installationId: 'test-installation',
        jobId: input.envelope.jobId,
        requestId: input.envelope.request.requestId,
        requestDigest,
        capabilityJti: `test-jti-${this.sequence}`,
      },
    };
  }

  async retainResult(input: RemoteJobRetainInput): Promise<RemoteJobRetention> {
    this.retentions.push(input.dispatch.jobId);
    const key = this.dispatchKey(input.dispatch);
    const record = this.records.get(key);
    if (!record || record.indeterminate) return { kind: 'indeterminate' };
    record.result = input.result;
    return { kind: 'retained', result: input.result };
  }

  async markIndeterminate(input: RemoteJobSealInput) {
    const record = this.records.get(this.dispatchKey(input.dispatch));
    if (!record) return { kind: 'unknown' as const };
    record.indeterminate = true;
    return { kind: 'sealed' as const };
  }

  private key(input: RemoteJobReserveInput): string {
    return `${input.envelope.tenantId}\0${input.envelope.projectId}\0${input.envelope.jobId}`;
  }

  private dispatchKey(dispatch: RemoteJobRetainInput['dispatch']): string {
    return `${dispatch.tenantId}\0${dispatch.projectId}\0${dispatch.jobId}`;
  }
}
