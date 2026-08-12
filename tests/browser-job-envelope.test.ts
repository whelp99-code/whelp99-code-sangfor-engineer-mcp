import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  browserExecutionRequestSchema,
  jobEnvelopeSchema,
  jobReceiptSchema,
  parseJobEnvelope,
  type BrowserExecutionPort,
  type BrowserExecutionResult,
  type JobReceipt,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { createInProcessJobExecutionPort } from '../packages/sangfor-jm-execution/src/index.js';

const v1Fixture: unknown = JSON.parse(readFileSync(
  new URL('./fixtures/browser-execution-request.v1.json', import.meta.url),
  'utf8',
));
const parsedV1Request = browserExecutionRequestSchema.parse(v1Fixture);
const issuedAt = '2026-08-12T10:00:00.000Z';
const expiresAt = '2026-08-12T10:05:00.000Z';
const acceptedAt = '2026-08-12T10:00:01.000Z';

const envelope = {
  schemaVersion: 'browser-job-envelope.v1',
  jobId: 'job-compatibility-1',
  tenantId: 'tenant-lab-1',
  projectId: 'project-lab-1',
  runId: 'run-lab-1',
  stepId: 'step-observe-1',
  issuedAt,
  expiresAt,
  capability: 'opaque-in-process-capability',
  request: parsedV1Request,
} as const;

const receipt = {
  schemaVersion: 'browser-job-receipt.v1',
  jobId: envelope.jobId,
  acceptedAt,
  status: 'PASS',
  observations: { title: 'Sangfor Console', count: 2 },
  mutationAttempted: false,
  evidenceRefs: ['artifact://jm/evidence-1'],
} as const;

describe('browser job contract compatibility', () => {
  it('keeps the existing browser-execution-request.v1 fixture compatible', () => {
    expect(browserExecutionRequestSchema.parse(v1Fixture)).toEqual(v1Fixture);
  });

  it('round-trips a strict versioned envelope and receipt through JSON', () => {
    expect(jobEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(jobReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it.each([
    ['selector', '#apply'],
    ['js', 'document.body.innerHTML'],
    ['cdpEndpoint', 'ws://127.0.0.1:9222/devtools/browser/secret'],
    ['cookie', 'session=secret'],
    ['storageState', { cookies: [] }],
    ['authorization', 'Bearer secret'],
  ])('rejects forbidden nested request field %s', (field, value) => {
    expect(() => jobEnvelopeSchema.parse({
      ...envelope,
      request: {
        ...parsedV1Request,
        operation: { ...parsedV1Request.operation, [field]: value },
      },
    })).toThrow();
  });

  it.each([
    ['selector', '#apply'],
    ['js', 'alert(1)'],
    ['cdpEndpoint', 'ws://127.0.0.1:9222'],
    ['cookie', 'secret=1'],
    ['storageState', '/tmp/state.json'],
    ['authorization', 'Bearer secret'],
  ])('rejects forbidden envelope field %s', (field, value) => {
    expect(() => jobEnvelopeSchema.parse({ ...envelope, [field]: value })).toThrow();
  });

  it.each([
    ['jobId', '../job-secret'],
    ['tenantId', '/var/run/tenant'],
    ['projectId', 'C:\\customers\\project'],
    ['runId', './local-run'],
    ['stepId', '/tmp/step'],
    ['capability', '/home/operator/capability'],
  ])('rejects path-like envelope value %s', (field, value) => {
    expect(() => jobEnvelopeSchema.parse({ ...envelope, [field]: value }))
      .toThrow(/opaque|path/i);
  });

  it('refuses malformed time ordering and expiry at an injected boundary time', () => {
    expect(() => jobEnvelopeSchema.parse({
      ...envelope,
      expiresAt: issuedAt,
    })).toThrow(/after/i);
    expect(() => jobEnvelopeSchema.parse({
      ...envelope,
      issuedAt: 'not-a-time',
    })).toThrow();
    expect(() => parseJobEnvelope(envelope, new Date('2026-08-12T10:05:00.000Z')))
      .toThrow(/expired/i);
  });

  it.each([
    ['request', { ...parsedV1Request, schemaVersion: 'browser-execution-request.v2' }],
    ['envelope', { ...envelope, schemaVersion: 'browser-job-envelope.v2' }],
  ])('refuses an unknown %s version with a typed schema error', (_contract, input) => {
    const result = _contract === 'request'
      ? browserExecutionRequestSchema.safeParse(input)
      : jobEnvelopeSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
      expect(result.error.issues.some((issue) => issue.path.includes('schemaVersion'))).toBe(true);
    }
  });

  it('composes envelope to port to receipt without changing the port result', async () => {
    const fakeResult: BrowserExecutionResult = {
      schemaVersion: 'browser-execution-result.v1',
      requestId: parsedV1Request.requestId,
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      observations: { title: 'Sangfor Console' },
      evidence: [{
        artifactRef: 'artifact://jm/evidence-1',
        sha256: 'a'.repeat(64),
        mediaType: 'image/png',
        size: 10,
      }],
    };
    const execute = vi.fn<BrowserExecutionPort['execute']>().mockResolvedValue(fakeResult);
    const receipts: JobReceipt[] = [];
    const port = createInProcessJobExecutionPort({ execute }, {
      tenantId: envelope.tenantId,
      projectId: envelope.projectId,
      capability: envelope.capability,
      now: () => new Date(issuedAt),
      onReceipt: (value) => receipts.push(value),
    });

    const output = await port.execute(parsedV1Request);

    expect(output).toBe(fakeResult);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(parsedV1Request);
    expect(receipts).toEqual([{
      schemaVersion: 'browser-job-receipt.v1',
      jobId: parsedV1Request.requestId,
      acceptedAt: issuedAt,
      status: fakeResult.status,
      observations: fakeResult.observations,
      mutationAttempted: fakeResult.mutationAttempted,
      evidenceRefs: ['artifact://jm/evidence-1'],
    }]);
  });
});
