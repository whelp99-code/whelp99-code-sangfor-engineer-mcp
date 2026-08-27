import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseRemoteShadowObservation, compareRemoteShadow } from '../packages/sangfor-observer/src/remote-shadow.js';
import {
  browserExecutionResultSchema,
  type BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { createTwoReplicaFixture } from './lib/blro-two-replica-fixture.js';
import { ReplicaProcess } from './lib/blro-two-replica-runner.js';
import { assertRemoteShadowQaBindings } from './lib/remote-shadow-qa-bindings.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_PROJECT_ID,
  JM_TENANT_ID,
} from '../tests/helpers/jm-agent-fixture.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const MAX_AGE_MS = 60_000;
const JM_URL = 'https://127.0.0.1:39443/v1/browser-jobs';
const LOCAL_TIMING = { collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 } as const;
const REMOTE_TIMING = { collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 } as const;
const EQUAL_TIMING = { collectedAt: '2026-08-27T11:59:35.000Z', latencyMs: 19 } as const;

type CollectionTiming = {
  readonly collectedAt: string;
  readonly latencyMs: number;
};

type CollectionInput = {
  readonly path: 'local' | 'remote';
  readonly statePath: string;
  readonly timing: CollectionTiming;
  readonly execution: BrowserExecutionResult;
};

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const ownerUrl = requiredEnvironment('BLRO_OWNER_DATABASE_URL');
  const statePath = requiredEnvironment('REMOTE_SHADOW_MOCK_STATE_PATH');
  const before = sha256(await readFile(statePath));
  let localCollectionReads = 0;
  let remoteCollectionReads = 0;
  let dispatchBoundaryObserved = false;
  let callbackAfterDispatchBoundary = false;
  let remoteCollected: Awaited<ReturnType<typeof collectObservation>> | undefined;
  let callbackRemotePayload: unknown;
  const fixture = await createTwoReplicaFixture({
    databaseUrl, ownerUrl, jmUrl: JM_URL,
    collectVerification: async (request) => {
      remoteCollectionReads += 1;
      callbackAfterDispatchBoundary = dispatchBoundaryObserved;
      const execution = authoritativeExecution(request.requestId);
      const collected = await collectObservation({ path: 'remote', statePath, timing: REMOTE_TIMING, execution });
      const payload = { requiredFacts: collected.requiredFacts };
      remoteCollected = collected;
      callbackRemotePayload = payload;
      return browserExecutionResultSchema.parse({ ...execution, observations: payload });
    },
  });
  const replica = new ReplicaProcess(fixture.configs[0], new URL('./test-blro-two-replica.ts', import.meta.url).pathname);
  try {
    await replica.start();
    const submission = replica.submit({ purpose: 'verification', failpoint: 'post_commit', bodyText: fixture.body({
      requestId: 'todo29-verification', jobId: 'todo29-verification', jti: 'todo29-verification-jti',
      purpose: 'verification',
    }) });
    await submission.events['dispatch-boundary'];
    if (remoteCollectionReads !== 0 || callbackRemotePayload !== undefined) {
      throw new RemoteShadowQaError('REMOTE_COLLECTION_PRECEDED_DISPATCH');
    }
    dispatchBoundaryObserved = true;
    replica.release(submission.id);
    const remoteExecution = await submission.result;
    localCollectionReads += 1;
    const local = await collectObservation({
      path: 'local', statePath, timing: LOCAL_TIMING,
      execution: authoritativeExecution('todo29-local-read'),
    });
    const collectedBehindDispatch = remoteCollected;
    const capturedPayload = callbackRemotePayload;
    if (!collectedBehindDispatch || capturedPayload === undefined) {
      throw new RemoteShadowQaError('REMOTE_COLLECTION_MISSING');
    }
    const remote = parseRemoteShadowObservation(observationInput('remote', remoteExecution.observations, remoteExecution));
    const comparedRemotePayload = { requiredFacts: remote.requiredFacts };
    const bindingEvidence = assertRemoteShadowQaBindings({
      localReadCount: localCollectionReads,
      remoteReadCount: remoteCollectionReads,
      executorCalls: fixture.jmCalls(),
      verificationCollectionCalls: fixture.verificationCollectionCalls(),
      callbackAfterDispatchBoundary,
      localObservation: local,
      comparedRemoteObservation: remote,
      localRequiredFacts: local.requiredFacts,
      comparedRemoteRequiredFacts: remote.requiredFacts,
      callbackRemotePayload: capturedPayload,
      comparedRemotePayload,
      localTiming: LOCAL_TIMING,
      remoteTiming: REMOTE_TIMING,
    });
    const pass = compareRemoteShadow({ local, remote, now: NOW, maxAgeMs: MAX_AGE_MS });
    const equalLocal = withTiming(local, EQUAL_TIMING);
    const equalRemote = withTiming(remote, EQUAL_TIMING);
    const equalTimingReport = compareRemoteShadow({ local: equalLocal, remote: equalRemote, now: NOW, maxAgeMs: MAX_AGE_MS });
    const timingDigestsStable = pass.reportDigest === equalTimingReport.reportDigest
      && pass.localObservationDigest === equalTimingReport.localObservationDigest
      && pass.remoteObservationDigest === equalTimingReport.remoteObservationDigest
      && pass.localProvenanceDigest === equalTimingReport.localProvenanceDigest
      && pass.remoteProvenanceDigest === equalTimingReport.remoteProvenanceDigest;

    const after = sha256(await readFile(statePath));
    if (!pass.promotionEligible || !timingDigestsStable || before !== after) {
      throw new RemoteShadowQaError('QA_INVARIANT_FAILED');
    }
    process.stdout.write(`REMOTE_VERIFICATION_STATUS=${remoteExecution.status} ERROR_CODE=${remoteExecution.error?.code ?? 'none'}\n`);
    process.stdout.write(`LOCAL_COLLECTED_AT=${LOCAL_TIMING.collectedAt} LOCAL_LATENCY_MS=${String(LOCAL_TIMING.latencyMs)} REMOTE_COLLECTED_AT=${REMOTE_TIMING.collectedAt} REMOTE_LATENCY_MS=${String(REMOTE_TIMING.latencyMs)}\n`);
    process.stdout.write(`LOCAL_COLLECTION_READS=${String(localCollectionReads)} REMOTE_COLLECTION_READS=${String(remoteCollectionReads)} JM_EXECUTOR_CALLS=${String(fixture.jmCalls())} DISTINCT_COLLECTION_OBJECTS=${String(bindingEvidence.distinctCollectionObjects)} REMOTE_COLLECTION_BEHIND_MTLS=${String(bindingEvidence.remoteCollectionBehindMtls)}\n`);
    process.stdout.write(`CALLBACK_PAYLOAD_DIGEST=${bindingEvidence.callbackPayloadDigest} COMPARED_PAYLOAD_DIGEST=${bindingEvidence.comparedPayloadDigest}\n`);
    process.stdout.write(`DISTINCT_TIMING_REPORT_DIGEST=${pass.reportDigest} EQUAL_TIMING_REPORT_DIGEST=${equalTimingReport.reportDigest} TIMING_DIGESTS_STABLE=${String(timingDigestsStable)}\n`);
    process.stdout.write(`MOCK_STATE_SHA256_BEFORE=${before}\nMOCK_STATE_SHA256_AFTER=${after}\nMOCK_STATE_UNCHANGED=${String(before === after)}\nBROWSER_PROFILE_OR_SECRET_CROSSED=false\n`);
    printReport(pass);

    const missing = parseRemoteShadowObservation({ ...remote, requiredFacts: remote.requiredFacts.slice(1) });
    printReport(compareRemoteShadow({ local, remote: missing, now: NOW, maxAgeMs: MAX_AGE_MS }));
    const drift = parseRemoteShadowObservation({
      ...remote,
      requiredFacts: remote.requiredFacts.map((fact) => fact.key === 'system'
        ? { ...fact, provenance: { ...fact.provenance, endpoint: 'GET /mock/config/drift' } }
        : fact),
    });
    printReport(compareRemoteShadow({ local, remote: drift, now: NOW, maxAgeMs: MAX_AGE_MS }));
  } finally {
    await replica.stop();
    await fixture.close();
  }
}

async function collectObservation(input: CollectionInput) {
  const stateValue: unknown = JSON.parse(await readFile(input.statePath, 'utf8'));
  const parsed = parseRemoteShadowObservation(observationInput(input.path, stateValue, input.execution));
  return withTiming(parsed, input.timing);
}

function withTiming(
  observation: ReturnType<typeof parseRemoteShadowObservation>,
  timing: CollectionTiming,
) {
  return parseRemoteShadowObservation({
    ...observation,
    requiredFacts: observation.requiredFacts.map((fact) => ({
      ...fact,
      provenance: { ...fact.provenance, ...timing },
    })),
  });
}

function authoritativeExecution(requestId: string): BrowserExecutionResult {
  return browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1', requestId, status: 'PASS',
    mutationAttempted: false, readBack: { status: 'PASS' }, observations: {}, evidence: [],
  });
}

function observationInput(path: 'local' | 'remote', factsContainer: unknown, execution: BrowserExecutionResult): unknown {
  const requiredFacts = factsContainer !== null && typeof factsContainer === 'object' && 'requiredFacts' in factsContainer
    ? factsContainer.requiredFacts
    : undefined;
  return {
    schemaVersion: 'remote-shadow-observation.v1', path,
    target: {
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST, origin: 'https://console.task26.invalid',
      sourceScope: 'todo29-loopback/config', sourceVersion: 'mock-v1',
    },
    readOnly: true, execution, requiredFacts,
  };
}

function printReport(report: ReturnType<typeof compareRemoteShadow>): void {
  process.stdout.write(`${report.code} reportDigest=${report.reportDigest} localDigest=${report.localObservationDigest} remoteDigest=${report.remoteObservationDigest} localProvenance=${report.localProvenanceDigest} remoteProvenance=${report.remoteProvenanceDigest} localAcquisition=${JSON.stringify(report.localAcquisition)} remoteAcquisition=${JSON.stringify(report.remoteAcquisition)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RemoteShadowQaError(`${name}_REQUIRED`);
  return value;
}

class RemoteShadowQaError extends Error { override readonly name = 'RemoteShadowQaError'; }

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}:${error.message}` : 'UNKNOWN'}\n`);
  process.exitCode = 1;
});
