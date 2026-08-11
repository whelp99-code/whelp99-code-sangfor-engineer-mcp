import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  verificationCheckFromBrowserResult,
  verifyResultLive,
} from '../packages/sangfor-verifier/src/index.js';

const plan = {
  id: 'plan-browser-port',
  product: 'HCI',
  planTitle: 'Browser port plan',
  planSummary: '',
  riskLevel: 'low',
  customerName: 'lab',
  steps: [],
  precheck: [],
  rollbackPlan: [],
  approvalRequiredSteps: [],
  manualReferences: [],
  wikiReferences: [],
  lessonReferences: [],
  validationPlan: [{
    id: 'dashboard',
    title: 'Mock HCI Console',
    description: 'Observe mock console title.',
    product: 'HCI',
    phase: 'validation',
    approvalRequired: false,
    riskLevel: 'low',
    references: ['mock-console'],
  }],
} as any;

function fakePort(output: Partial<BrowserExecutionResult>): BrowserExecutionPort {
  return {
    execute: vi.fn(async (request): Promise<BrowserExecutionResult> => ({
      schemaVersion: 'browser-execution-result.v1',
      requestId: request.requestId,
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      evidence: [],
      ...output,
    })),
  };
}

describe('verifier browser execution port', () => {
  it('maps INDETERMINATE mutation evidence to manual_required', () => {
    const check = verificationCheckFromBrowserResult(
      plan.validationPlan[0],
      {
        schemaVersion: 'browser-execution-result.v1',
        requestId: 'verify-indeterminate',
        status: 'INDETERMINATE',
        mutationAttempted: true,
        readBack: { status: 'INDETERMINATE' },
        evidence: [],
      },
    );

    expect(check.status).toBe('manual_required');
  });

  it('marks PASS only when the injected port returns PASS read-back', async () => {
    const port = fakePort({
      observations: { title: 'Mock Sangfor HCI Console' },
    });

    const result = await verifyResultLive({
      plan,
      mode: 'observe',
      targetUrl: 'http://127.0.0.1:3400/hci',
      sessionId: 'verify-session',
      executionPort: port,
    });

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.status).toBe('passed');
    expect(port.execute).toHaveBeenCalledOnce();
  });

  it('does not turn an Apply attempt into PASS without read-back', async () => {
    const previous = process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    const port = fakePort({
      status: 'INDETERMINATE',
      mutationAttempted: true,
      readBack: { status: 'INDETERMINATE' },
    });

    try {
      const result = await verifyResultLive({
        plan,
        mode: 'apply',
        targetUrl: 'http://127.0.0.1:3400/hci',
        sessionId: 'verify-session',
        executionPort: port,
      });

      expect(result.ok).toBe(false);
      expect(result.checks[0]?.status).not.toBe('passed');
    } finally {
      if (previous === undefined) delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
      else process.env.SANGFOR_ALLOW_REAL_EXECUTION = previous;
    }
  });
});
