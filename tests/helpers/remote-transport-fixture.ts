import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  browserExecutionResultSchema,
  mintJobCapability,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';

export const remoteTransportIssuedAt = new Date('2026-08-12T10:00:00.000Z');
const capabilityKeys = generateKeyPairSync('ed25519');
const privateKey = capabilityKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

export const remoteTransportDeclaredVersion =
  `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor}`;
export const remoteTransportDeclaredHeaders = {
  [CONTRACT_VERSION_HEADER]: remoteTransportDeclaredVersion,
} as const;

export function remoteTransportRequest(
  operation: BrowserExecutionRequest['operation'],
  requestId = `request-${operation.kind}`,
): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId,
    sessionId: 'session-remote-1',
    origin: 'http://127.0.0.1:3400',
    operation,
  };
}

export function remoteTransportPassResult(
  requestId: string,
  observations: Record<string, string> = {},
): BrowserExecutionResult {
  return browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'PASS',
    mutationAttempted: false,
    readBack: { status: 'PASS' },
    observations,
    evidence: [],
  });
}

export function remoteTransportEnvelopeOptions() {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    runId: 'run-a',
    stepId: 'step-a',
    now: () => remoteTransportIssuedAt,
    ttlMs: 60_000,
    capability: ({ request, runId, stepId, jobId, issuedAt, expiresAt }: {
      readonly request: BrowserExecutionRequest;
      readonly runId: string;
      readonly stepId: string;
      readonly jobId: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    }) => mintJobCapability({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      runId,
      stepId,
      jobId,
      clientIdentityId: 'client:install-a',
      installationId: 'install-a',
      request,
      issuedAt,
      expiresAt,
      jti: randomUUID(),
      privateKey,
    }),
  };
}
