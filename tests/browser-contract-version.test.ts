import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  browserExecutionResultSchema,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  JM_SUPPORTED_MINOR_LAG,
  NODE_RUNTIME_PINS,
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  buildRemoteJobEnvelope,
  createRemoteBrowserJobHandler,
  type RemoteJobStore,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import { mintJobCapability } from '../packages/sangfor-browser-contracts/src/capability.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';

const issuedAt = new Date('2026-08-12T10:00:00.000Z');
const capabilityKeys = generateKeyPairSync('ed25519');
const privateKey = capabilityKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const supported = `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor}`;
const adjacent = `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor - JM_SUPPORTED_MINOR_LAG}`;

const baseRequest = (requestId: string): BrowserExecutionRequest => ({
  schemaVersion: 'browser-execution-request.v1',
  requestId,
  sessionId: 'session-version-1',
  origin: 'http://127.0.0.1:3400',
  operation: { kind: 'observe_console', includeSnapshot: true },
});

const passResult = (requestId: string): BrowserExecutionResult =>
  browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'PASS',
    mutationAttempted: false,
    readBack: { status: 'PASS' },
    observations: { title: 'Sangfor Mock Console' },
    evidence: [],
  });

function envelopeOptions() {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    runId: 'run-a',
    stepId: 'step-a',
    now: () => issuedAt,
    ttlMs: 60_000,
    capability: ({ request, runId, stepId, jobId, issuedAt: issued, expiresAt }: {
      request: BrowserExecutionRequest;
      runId: string;
      stepId: string;
      jobId: string;
      issuedAt: Date;
      expiresAt: Date;
    }) => mintJobCapability({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      runId,
      stepId,
      jobId,
      clientIdentityId: 'client:install-a',
      installationId: 'install-a',
      request,
      issuedAt: issued,
      expiresAt,
      jti: `cap-${jobId}`,
      privateKey,

    authorityEpoch: 0,}),
  };
}

/** A store that records every reserve, so "refused before lookup" is provable. */
function countingStore(): TestRemoteJobStore {
  return new TestRemoteJobStore();
}

function bodyFor(requestId: string): string {
  return JSON.stringify(buildRemoteJobEnvelope(baseRequest(requestId), envelopeOptions()));
}

function handlerWith(store: RemoteJobStore) {
  const execute = vi.fn(async (input: BrowserExecutionRequest) => passResult(input.requestId));
  const handler = createRemoteBrowserJobHandler({
    executor: { execute },
    authorizeClient: () => true,
    jobStore: store,
    now: () => issuedAt,
  });
  return { execute, handler };
}

function inputWith(
  requestId: string,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
) {
  return {
    client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
    method: 'POST',
    urlPath: REMOTE_BROWSER_JOB_PATH,
    bodyText: bodyFor(requestId),
    headers,
  };
}


describe('browser contract version negotiation at the job boundary', () => {
  it('reaches the executor for a supported adjacent JM version', async () => {
    // Given a JM one supported minor behind, When it dispatches a read-only job,
    // Then the transport completes and the executor runs exactly once.
    const store = countingStore();
    const { execute, handler } = handlerWith(store);

    const response = await handler.handle(inputWith('job-supported', {
      [CONTRACT_VERSION_HEADER]: adjacent,
    }));

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.reserves).toEqual(['job-supported']);
    expect(JSON.parse(response.bodyText)).toMatchObject({ status: 'PASS' });
  });

  it.each([
    ['missing', {}],
    // Node lowercases incoming field names (RFC 9110 §5.1), so a mixed-case key
    // only reaches the handler from a non-HTTP caller. The handler still refuses
    // it: it reads the canonical key exactly and never scans case-insensitively.
    ['non_canonical_header_key', { 'X-Sangfor-Browser-Contract-Version': supported }],
    ['unrelated_header_only', { 'content-type': 'application/json' }],
    ['empty_value', { [CONTRACT_VERSION_HEADER]: '' }],
    // Node strips optional whitespace around field values before req.headers, so
    // padding only arrives from a non-HTTP caller; the handler refuses it rather
    // than trimming, which keeps one canonical form across every caller.
    ['whitespace_padded', { [CONTRACT_VERSION_HEADER]: ` ${supported} ` }],
    ['duplicate_values', { [CONTRACT_VERSION_HEADER]: [supported, supported] }],
    ['comma_joined', { [CONTRACT_VERSION_HEADER]: `${supported}, ${supported}` }],
    ['unknown', { [CONTRACT_VERSION_HEADER]: 'browser-contract.vNEXT' }],
    ['future', { [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major + 1}.0` }],
    ['too_old', { [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major - 1}.9` }],
  ])(
    'refuses a %s declaration before any idempotency lookup or dispatch',
    async (_case, headers) => {
      const store = countingStore();
      const { execute, handler } = handlerWith(store);

      const response = await handler.handle(inputWith('job-refused', headers));

      expect(response.statusCode).toBe(426);
      expect(execute).not.toHaveBeenCalled();
      expect(store.reserves).toEqual([]);
      expect(store.retentions).toEqual([]);
      expect(JSON.parse(response.bodyText)).toMatchObject({
        error: { code: REMOTE_TRANSPORT_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED },
      });
      expect(response.headers[CONTRACT_VERSION_HEADER]).toBe(supported);
    },
  );

  it('refuses an unsupported peer before the envelope body is even trusted', async () => {
    const store = countingStore();
    const { execute, handler } = handlerWith(store);

    const response = await handler.handle({
      client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
      method: 'POST',
      urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: '{ this is not json',
      headers: { [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major + 1}.0` },
    });

    expect(response.statusCode).toBe(426);
    expect(execute).not.toHaveBeenCalled();
    expect(store.reserves).toEqual([]);
  });

  it('cannot replay a stored result to an undeclared peer', async () => {
    // Given a job already executed and cached by a supported peer,
    // When the same job is replayed without a declaration,
    // Then the cache is never consulted and nothing is returned from it.
    const store = countingStore();
    const { execute, handler } = handlerWith(store);
    await handler.handle(inputWith('job-replay', { [CONTRACT_VERSION_HEADER]: supported }));
    expect(store.retentions).toEqual(['job-replay']);

    const replay = await handler.handle(inputWith('job-replay', {}));

    expect(replay.statusCode).toBe(426);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.reserves).toEqual(['job-replay']);
  });

  it('pins the Node runtime lanes and the pnpm version the toolchain proves', () => {
    expect(NODE_RUNTIME_PINS).toEqual({ blroMajor: 22, jmMajor: 24, pnpm: '10.28.1' });
  });
});
