import {
  browserExecutionResultSchema,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';

export function taskPassResult(
  requestId: string,
  marker = 'retained',
): BrowserExecutionResult {
  return browserExecutionResultSchema.parse({
    schemaVersion: 'browser-execution-result.v1', requestId, status: 'PASS',
    mutationAttempted: false, readBack: { status: 'PASS' },
    observations: { marker }, evidence: [],
  });
}

export function parseTaskResult(bodyText: string): BrowserExecutionResult {
  const body: unknown = JSON.parse(bodyText);
  return browserExecutionResultSchema.parse(body);
}
