import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  jobEnvelopeSchema,
  jobReceiptSchema,
  type BrowserExecutionPort,
  type JobReceipt,
} from '../../sangfor-browser-contracts/src/index.js';

export interface InProcessJobExecutionOptions {
  readonly tenantId: string;
  readonly projectId: string;
  readonly capability: string;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly onReceipt?: (receipt: JobReceipt) => void;
}

const DEFAULT_JOB_TTL_MS = 60_000;

/**
 * Frames the existing in-process port call as a validated job. The opaque
 * capability is transport data only; this seam does not authorize or verify it.
 */
export function createInProcessJobExecutionPort(
  delegate: BrowserExecutionPort,
  options: InProcessJobExecutionOptions,
): BrowserExecutionPort {
  return {
    async execute(input) {
      const request = browserExecutionRequestSchema.parse(input);
      const issuedAt = (options.now ?? (() => new Date()))();
      const envelope = jobEnvelopeSchema.parse({
        schemaVersion: 'browser-job-envelope.v1',
        jobId: request.requestId,
        tenantId: options.tenantId,
        projectId: options.projectId,
        runId: request.sessionId,
        stepId: request.requestId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(
          issuedAt.getTime() + (options.ttlMs ?? DEFAULT_JOB_TTL_MS),
        ).toISOString(),
        capability: options.capability,
        request,
      });

      const result = await delegate.execute(envelope.request);
      const parsedResult = browserExecutionResultSchema.parse(result);
      const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
      const receipt = jobReceiptSchema.parse({
        schemaVersion: 'browser-job-receipt.v1',
        jobId: envelope.jobId,
        acceptedAt,
        status: parsedResult.status,
        observations: parsedResult.observations ?? {},
        mutationAttempted: parsedResult.mutationAttempted,
        evidenceRefs: parsedResult.evidence.map((evidence) => evidence.artifactRef),
      });
      options.onReceipt?.(receipt);

      return result;
    },
  };
}
