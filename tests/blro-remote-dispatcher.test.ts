import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createBlroRemoteDispatcher,
  type BlroDispatchAuthority,
  type BlroJmTransport,
} from '../packages/sangfor-authority/src/blro-remote-dispatcher.js';
import {
  buildRemoteJobEnvelope,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
  type JobEnvelope,
  type RemoteJobDispatch,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { RemoteJobAuthorityFixture } from './helpers/remote-job-authority-fixture.js';
import { scopedOwnerQuery } from './helpers/scoped-owner-database.js';

const request = (requestId: string, kind: 'mutation' | 'verification'): BrowserExecutionRequest => ({
  schemaVersion: 'browser-execution-request.v1', requestId, sessionId: 'session-a',
  origin: 'https://device.example.test',
  operation: kind === 'mutation'
    ? { kind: 'perform_console_action', action: { type: 'click', target: 'Apply', dryRun: false } }
    : { kind: 'verify_console', checks: [{ id: 'enabled', kind: 'field_equals', expected: 'true' }] },
});

const envelope = (requestId: string, kind: 'mutation' | 'verification'): JobEnvelope =>
  buildRemoteJobEnvelope(request(requestId, kind), {
    tenantId: 'tenant-a', projectId: 'project-a', runId: `run-${requestId}`,
    stepId: `step-${requestId}`, jobId: () => `job-${requestId}`,
    capability: `capability-${requestId}`, now: () => new Date('2099-08-27T00:00:00.000Z'),
  });

const result = (requestId: string, status: 'PASS' | 'FAIL' | 'INDETERMINATE', mutationAttempted: boolean): BrowserExecutionResult => ({
  schemaVersion: 'browser-execution-result.v1', requestId, status, mutationAttempted,
  readBack: { status }, observations: { password: 'customer-secret', enabled: status === 'PASS' }, evidence: [],
});

class FakeAuthority implements BlroDispatchAuthority {
  readonly events: string[] = [];
  readonly retained = new Map<string, BrowserExecutionResult>();
  readonly reservations = new Map<string, RemoteJobDispatch>();
  authorize = true;
  preflightFailure = false;
  conflict = false;

  async authorizeTarget(): Promise<boolean> { this.events.push('authorize'); return this.authorize; }
  async classify(input: { readonly envelope: JobEnvelope }) {
    this.events.push('classify');
    if (this.conflict) return { kind: 'refused' as const, reason: 'REQUEST_CONFLICT' as const };
    const existing = this.retained.get(input.envelope.jobId);
    if (existing) return { kind: 'retained' as const, result: existing };
    if (this.reservations.has(input.envelope.jobId)) {
      return { kind: 'indeterminate' as const, requestId: input.envelope.request.requestId };
    }
    return { kind: 'candidate' as const, claim: {
      jti: `jti-${input.envelope.jobId}`, clientIdentityId: 'client-a', installationId: 'install-a',
      authorityEpoch: 1,
    } };
  }
  async reserve(input: { readonly envelope: JobEnvelope }) {
    this.events.push('reserve');
    const found = this.reservations.get(input.envelope.jobId);
    if (found) return { kind: 'indeterminate' as const, requestId: found.requestId };
    const dispatch: RemoteJobDispatch = {
      dispatchId: `dispatch-${input.envelope.jobId}`, tenantId: 'tenant-a', projectId: 'project-a',
      authorityEpoch: 1, installationId: 'install-a', jobId: input.envelope.jobId,
      requestId: input.envelope.request.requestId, requestDigest: 'a'.repeat(64),
      capabilityJti: `jti-${input.envelope.jobId}`,
    };
    this.reservations.set(input.envelope.jobId, dispatch);
    return { kind: 'dispatch' as const, dispatch };
  }
  async retainResult(input: { readonly dispatch: RemoteJobDispatch; readonly result: BrowserExecutionResult }) {
    this.events.push('retain'); this.retained.set(input.dispatch.jobId, input.result);
    return { kind: 'retained' as const, result: input.result };
  }
  async markIndeterminate(): Promise<{ readonly kind: 'sealed' }> { this.events.push('seal'); return { kind: 'sealed' }; }
}

class FakeTransport implements BlroJmTransport {
  readonly events: string[] = [];
  executions = 0;
  ready = true;
  dispatchResult: BrowserExecutionResult = result('mutation-a', 'PASS', true);
  dispatchKind: 'response' | 'predispatch_refused' | 'indeterminate' = 'response';
  readonly started: Promise<void>;
  private signalStarted: (() => void) | undefined;
  private release: (() => void) | undefined;
  private barrier: Promise<void> | undefined;

  constructor() {
    this.started = new Promise((resolve) => { this.signalStarted = resolve; });
  }
  holdDispatch(): void { this.barrier = new Promise((resolve) => { this.release = resolve; }); }
  releaseDispatch(): void { this.release?.(); }
  async preflight(): Promise<boolean> { this.events.push('preflight'); return this.ready; }
  async dispatch(input: { readonly envelope: JobEnvelope }) {
    this.events.push('dispatch'); this.executions += 1; this.signalStarted?.(); await this.barrier;
    if (this.dispatchKind === 'predispatch_refused') return { kind: 'predispatch_refused' as const };
    if (this.dispatchKind === 'indeterminate') return { kind: 'indeterminate' as const };
    return { kind: 'response' as const, result: { ...this.dispatchResult, requestId: input.envelope.request.requestId } };
  }
}

const target = {
  tenantId: 'tenant-a', projectId: 'project-a', installationId: 'install-a',
  clientIdentityId: 'client-a', deviceBindingDigest: 'd'.repeat(64),
  origin: 'https://device.example.test', certificate: { encoding: 'der-base64' as const, value: 'YQ==' },
  endpointUrl: 'https://127.0.0.1:39443', environment: 'production' as const,
};

function fixture() {
  const authority = new FakeAuthority(); const transport = new FakeTransport();
  const dispatcher = createBlroRemoteDispatcher({ authority, transport,
    executionPolicy: { allowRealExecution: true, allowProductionExecution: true },
    receiptSigner: { sign: () => 'signed-receipt', keyId: 'key-a', keyDigest: 'b'.repeat(64),
      clientCertificateFingerprintSha256: 'c'.repeat(64), now: () => new Date('2026-08-27T00:00:00.000Z') } });
  return { authority, transport, dispatcher };
}

describe('BLRO production remote dispatcher', () => {
  it('authorizes target before parsing or retained-result lookup', async () => {
    const { authority, transport, dispatcher } = fixture(); authority.authorize = false;
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: '{bad-json', target });
    expect(output.status).toBe('REFUSED');
    expect(authority.events).toEqual(['authorize']); expect(transport.executions).toBe(0);
  });

  it.each([
    ['wrong origin', { ...target, origin: 'https://other.example.test' }],
    ['wrong scope', { ...target, installationId: 'other-installation' }],
    ['wrong project', { ...target, projectId: 'project-b' }],
  ])('refuses %s before preflight and dispatch', async (_name, changed) => {
    const { authority, transport, dispatcher } = fixture();
    authority.authorizeTarget = async () => { authority.events.push('authorize'); return false; };
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target: changed });
    expect(output.status).toBe('REFUSED'); expect(transport.events).toEqual([]);
  });

  it('refuses wrong action or request-bound capability before preflight', async () => {
    const { transport, dispatcher } = fixture();
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('verify-a', 'verification')), target });
    expect(output.status).toBe('REFUSED'); expect(transport.events).toEqual([]);
  });

  it('returns an exact retained duplicate and never preflights or dispatches it', async () => {
    const { authority, transport, dispatcher } = fixture();
    authority.retained.set('job-mutation-a', result('mutation-a', 'PASS', true));
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output.status).toBe('INDETERMINATE'); expect(transport.events).toEqual([]);
  });

  it('refuses a request-digest conflict without preflight or cache disclosure', async () => {
    const { authority, transport, dispatcher } = fixture(); authority.conflict = true;
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output.status).toBe('REFUSED'); expect(transport.events).toEqual([]);
  });

  it('dispatches exactly once for 32 concurrent exact duplicates', async () => {
    const { transport, dispatcher } = fixture(); transport.holdDispatch();
    const bodyText = JSON.stringify(envelope('mutation-a', 'mutation'));
    const calls = Array.from({ length: 32 }, () => dispatcher.submit({ purpose: 'mutation', bodyText, target }));
    await transport.started;
    transport.releaseDispatch(); const outputs = await Promise.all(calls);
    expect(transport.executions).toBe(1); expect(outputs.every((value) => value.status !== 'PASS')).toBe(true);
  });

  it('does not reserve when the real JM read-only preflight is unavailable', async () => {
    const { authority, transport, dispatcher } = fixture(); transport.ready = false;
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output.status).toBe('REFUSED'); expect(authority.events).toEqual(['authorize', 'classify']);
  });

  it('retains a definite pre-dispatch connection refusal without a possible-dispatch verdict', async () => {
    const { authority, transport, dispatcher } = fixture(); transport.dispatchKind = 'predispatch_refused';
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output).toMatchObject({ status: 'REFUSED', mutationAttempted: false });
    expect(authority.events).toContain('retain');
  });

  it('seals post-dispatch disconnect as restart-sticky INDETERMINATE with zero retry', async () => {
    const { authority, transport, dispatcher } = fixture(); transport.dispatchKind = 'indeterminate';
    const bodyText = JSON.stringify(envelope('mutation-a', 'mutation'));
    const first = await dispatcher.submit({ purpose: 'mutation', bodyText, target });
    const restarted = createBlroRemoteDispatcher({ authority, transport,
      executionPolicy: { allowRealExecution: true, allowProductionExecution: true },
      receiptSigner: { sign: () => 'receipt', keyId: 'key', keyDigest: 'b'.repeat(64),
        clientCertificateFingerprintSha256: 'c'.repeat(64), now: () => new Date('2099-08-27T00:00:00.000Z') } });
    const second = await restarted.submit({ purpose: 'mutation', bodyText, target });
    expect([first.status, second.status]).toEqual(['INDETERMINATE', 'INDETERMINATE']);
    expect(transport.executions).toBe(1);
  });

  it('never accepts a mutation response as authoritative PASS and masks secrets', async () => {
    const { authority, dispatcher } = fixture();
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output.status).toBe('INDETERMINATE');
    expect(JSON.stringify([output, ...authority.retained.values()])).not.toContain('customer-secret');
  });

  it.each([
    ['PASS', 'PASS'], ['FAIL', 'FAIL'], ['INDETERMINATE', 'INDETERMINATE'],
  ] as const)('allows separate verification %s to produce only %s', async (observed, expected) => {
    const { transport, dispatcher } = fixture(); transport.dispatchResult = result('verification-a', observed, false);
    const output = await dispatcher.submit({ purpose: 'verification', bodyText: JSON.stringify(envelope('verification-a', 'verification')), target });
    expect(output.status).toBe(expected); expect(transport.executions).toBe(1);
  });

  it('enforces both production execution gates', async () => {
    const authority = new FakeAuthority(); const transport = new FakeTransport();
    const dispatcher = createBlroRemoteDispatcher({ authority, transport,
      executionPolicy: { allowRealExecution: true, allowProductionExecution: false },
      receiptSigner: { sign: () => 'receipt', keyId: 'key', keyDigest: 'b'.repeat(64),
        clientCertificateFingerprintSha256: 'c'.repeat(64), now: () => new Date() } });
    const output = await dispatcher.submit({ purpose: 'mutation', bodyText: JSON.stringify(envelope('mutation-a', 'mutation')), target });
    expect(output.status).toBe('REFUSED'); expect(authority.events).toEqual([]);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.BLRO_OWNER_DATABASE_URL;
describe.skipIf(!databaseUrl || !ownerUrl)('BLRO dispatcher PostgreSQL production seam', () => {
  let authorityFixture: RemoteJobAuthorityFixture;
  beforeAll(async () => { authorityFixture = await RemoteJobAuthorityFixture.create(databaseUrl ?? '', ownerUrl ?? ''); });
  beforeEach(async () => authorityFixture.reset());
  afterAll(async () => authorityFixture.close());

  it('atomically dispatches one of 32 duplicates and a distinct verification can alone PASS', async () => {
    const transport = new FakeTransport();
    const dispatcher = createBlroRemoteDispatcher({ authority: authorityFixture.store(), transport,
      executionPolicy: { allowRealExecution: true, allowProductionExecution: true },
      receiptSigner: { sign: () => 'signed-receipt', keyId: 'key-a', keyDigest: 'b'.repeat(64),
        clientCertificateFingerprintSha256: 'c'.repeat(64), now: () => authorityFixture.now } });
    const scopedTarget = { ...target, tenantId: authorityFixture.tenantId,
      projectId: authorityFixture.primaryProjectId, installationId: authorityFixture.installationId,
      clientIdentityId: authorityFixture.clientIdentityId,
      deviceBindingDigest: authorityFixture.deviceBindingDigest, origin: authorityFixture.origin,
      certificate: { encoding: 'der-base64' as const, value: authorityFixture.certificates.validDerBase64 } };
    const mutation = { ...authorityFixture.request('mutation-pg'), operation: {
      kind: 'perform_console_action' as const,
      action: { type: 'click' as const, target: 'Apply', dryRun: false },
    } };
    const submissions = Array.from({ length: 32 }, () => dispatcher.submit({
      purpose: 'mutation', target: scopedTarget,
      bodyText: JSON.stringify(authorityFixture.envelope({ request: mutation, jobId: 'mutation-pg' })),
    }));
    const mutationOutputs = await Promise.all(submissions);
    transport.dispatchResult = result('verification-pg', 'PASS', false);
    const verificationRequest = { ...authorityFixture.request('verification-pg'), operation: {
      kind: 'verify_console' as const,
      checks: [{ id: 'enabled', kind: 'field_equals' as const, expected: 'true' }],
    } };
    const verification = await dispatcher.submit({ purpose: 'verification', target: scopedTarget,
      bodyText: JSON.stringify(authorityFixture.envelope({ request: verificationRequest, jobId: 'verification-pg' })) });
    const rows = await scopedOwnerQuery<{ readonly state: string }>({ owner: authorityFixture.owner,
      projectId: authorityFixture.primaryProjectId,
      query: `SELECT "state" FROM "BlroRemoteJob" WHERE "projectId"=$1 ORDER BY "jobId"`,
      values: [authorityFixture.primaryProjectId] });
    expect(transport.executions).toBe(2);
    expect(mutationOutputs.every((output) => output.status !== 'PASS')).toBe(true);
    expect(verification.status).toBe('PASS');
    expect(rows).toEqual([{ state: 'result_retained' }, { state: 'result_retained' }]);
  });
});
