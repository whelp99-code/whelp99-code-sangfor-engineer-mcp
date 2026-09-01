import { describe, expect, it } from 'vitest';
import {
  REMOTE_JOB_REFUSAL_REASONS,
  browserExecutionResultSchema,
  jobEnvelopeSchema,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';

const envelope = jobEnvelopeSchema.parse({
  schemaVersion: 'browser-job-envelope.v1',
  jobId: 'fake-job', tenantId: 'fake-tenant', projectId: 'fake-project',
  runId: 'fake-run', stepId: 'fake-step', capability: 'fake-capability',
  issuedAt: '2026-08-26T13:00:00.000Z', expiresAt: '2026-08-26T13:01:00.000Z',
  request: {
    schemaVersion: 'browser-execution-request.v1', requestId: 'fake-request',
    sessionId: 'fake-session', origin: 'https://fake.test',
    operation: { kind: 'observe_console' },
  },
});
const result = browserExecutionResultSchema.parse({
  schemaVersion: 'browser-execution-result.v1', requestId: 'fake-request',
  status: 'PASS', mutationAttempted: false, readBack: { status: 'PASS' }, evidence: [],
});

describe('test remote-job store fake', () => {
  it('matches dispatch, retention, duplicate, and digest-conflict port behavior', async () => {
    // Given an empty fake implementing the pure production port.
    const store = new TestRemoteJobStore();

    // When a first reservation is retained and exact or changed duplicates arrive.
    const first = await store.authorizeAndReserve({ envelope, certificate: undefined });
    if (first.kind !== 'dispatch') throw new TypeError('fake did not reserve dispatch');
    await store.retainResult({ dispatch: first.dispatch, result });
    const retained = await store.authorizeAndReserve({
      envelope: { ...envelope, capability: 'fresh-capability' }, certificate: undefined,
    });
    const conflict = await store.authorizeAndReserve({
      envelope: { ...envelope, request: { ...envelope.request, requestId: 'changed-request' } },
      certificate: undefined,
    });

    // Then it returns retained machine data and refuses the changed digest.
    expect(retained).toEqual({ kind: 'retained', result });
    expect(conflict).toEqual({
      kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT,
    });
  });
});
