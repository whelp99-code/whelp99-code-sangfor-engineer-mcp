import { describe, expect, it } from 'vitest';
import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  type BrowserExecutionPort,
  type BrowserExecutionRequest,
} from '../packages/sangfor-browser-contracts/src/index.js';

const request = (
  operation: BrowserExecutionRequest['operation'],
): BrowserExecutionRequest => ({
  schemaVersion: 'browser-execution-request.v1',
  requestId: `request-${operation.kind}`,
  sessionId: 'session-local-1',
  origin: 'http://127.0.0.1:3400',
  operation,
});

describe('BrowserExecutionPort contracts', () => {
  it.each([
    { kind: 'observe_console', includeSnapshot: true },
    {
      kind: 'perform_console_action',
      action: { type: 'screenshot', target: 'current-page', dryRun: true },
    },
    {
      kind: 'verify_console',
      checks: [{ id: 'title', kind: 'text_contains', expected: 'Sangfor' }],
    },
    {
      kind: 'capture_console_evidence',
      captureId: 'capture-1',
      menuPath: [{ menu: 'Dashboard' }],
    },
  ] satisfies BrowserExecutionRequest['operation'][])(
    'round-trips $kind through JSON',
    (operation) => {
      const parsed = browserExecutionRequestSchema.parse(
        JSON.parse(JSON.stringify(request(operation))),
      );

      expect(parsed).toEqual(request(operation));
    },
  );

  it('dispatches a typed request through an implementation', async () => {
    const port: BrowserExecutionPort = {
      async execute(input) {
        return browserExecutionResultSchema.parse({
          schemaVersion: 'browser-execution-result.v1',
          requestId: input.requestId,
          status: 'PASS',
          mutationAttempted: false,
          readBack: { status: 'PASS' },
          observations: { title: 'Sangfor Mock Console' },
          evidence: [],
        });
      },
    };

    const result = await port.execute(request({
      kind: 'observe_console',
      includeSnapshot: true,
    }));

    expect(result.status).toBe('PASS');
    expect(result.readBack?.status).toBe('PASS');
    expect(result.observations).toEqual({ title: 'Sangfor Mock Console' });
  });

  it('accepts opaque artifact URIs and rejects filesystem paths', () => {
    const result = {
      schemaVersion: 'browser-execution-result.v1',
      requestId: 'request-artifact',
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      observations: {},
      evidence: [{
        artifactRef: `artifact://jm/${'a'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        mediaType: 'image/png',
        size: 8,
      }],
    };

    expect(() => browserExecutionResultSchema.parse(result)).not.toThrow();
    expect(() => browserExecutionResultSchema.parse({
      ...result,
      evidence: [{ ...result.evidence[0], artifactRef: '/tmp/capture.png' }],
    })).toThrow(/artifact/i);
  });
});
