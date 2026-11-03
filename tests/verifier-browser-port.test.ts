import { describe, expect, it, vi } from 'vitest';
import type { ConfigPlan, ConfigStep } from '../packages/shared/src/index.js';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  verificationCheckFromBrowserResult,
  verifyResult,
  verifyResultLive,
} from '../packages/sangfor-verifier/src/index.js';

const validationStep: ConfigStep = {
  id: 'dashboard',
  title: 'Mock HCI Console',
  description: 'Observe mock console title.',
  product: 'HCI',
  phase: 'validate',
  approvalRequired: false,
  riskLevel: 'low',
  references: ['mock-console'],
};

const plan: ConfigPlan = {
  id: 'plan-browser-port',
  product: 'HCI',
  planTitle: 'Browser port plan',
  planSummary: '',
  riskLevel: 'low',
  customerName: 'lab',
  steps: [{ ...validationStep, id: 'configure' }],
  precheck: [{ ...validationStep, id: 'precheck' }],
  rollbackPlan: [{ ...validationStep, id: 'rollback' }],
  approvalRequiredSteps: [],
  manualReferences: [{
    id: 'mock-console', product: 'HCI', title: 'Fixture manual',
    text: 'Fixture console checks only.', sourceType: 'manual', trustLevel: 'official',
  }],
  wikiReferences: [],
  lessonReferences: [],
  validationPlan: [validationStep],
};

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

const observeInput = {
  plan,
  mode: 'observe' as const,
  targetUrl: 'http://127.0.0.1:3400/hci',
  sessionId: 'verify-session',
};

describe('verifier browser execution port', () => {
  it('maps INDETERMINATE mutation evidence to manual_required', () => {
    const check = verificationCheckFromBrowserResult(
      validationStep,
      {
        schemaVersion: 'browser-execution-result.v1',
        requestId: 'verify-indeterminate',
        status: 'INDETERMINATE',
        mutationAttempted: true,
        readBack: { status: 'INDETERMINATE' },
        evidence: [],
      },
      'verify-indeterminate',
    );
    expect(check.status).toBe('manual_required');
  });

  it('marks PASS only for a valid plan and a fresh read-only PASS read-back', async () => {
    const port = fakePort({ observations: { title: 'Mock Sangfor HCI Console' } });
    const result = await verifyResultLive({ ...observeInput, executionPort: port });
    expect(result.ok).toBe(true);
    expect(result.planErrors).toEqual([]);
    expect(result.checks[0]?.status).toBe('passed');
    expect(port.execute).toHaveBeenCalledOnce();
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: 'verify_console' }),
    }));
  });

  it('refuses an invalid plan before contacting the verification port', async () => {
    const port = fakePort({});
    const result = await verifyResultLive({
      ...observeInput,
      plan: { ...plan, steps: [], rollbackPlan: [] },
      executionPort: port,
    });
    expect(result.ok).toBe(false);
    expect(result.planErrors).toEqual(expect.arrayContaining(['steps are required', 'rollbackPlan is required']));
    expect(port.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a response from another request', output: { requestId: 'prior-request' } },
    { label: 'the mutation response itself', output: { mutationAttempted: true } },
  ])('does not accept $label as independent verification', async ({ output }) => {
    const port = fakePort(output);
    const result = await verifyResultLive({ ...observeInput, executionPort: port });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.status).toBe('manual_required');
    expect(port.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'missing read-back', output: { readBack: undefined } },
    { label: 'uncertain read-back', output: { readBack: { status: 'INDETERMINATE' as const } } },
    { label: 'uncertain operation', output: { status: 'INDETERMINATE' as const } },
    { label: 'failed read-back', output: { readBack: { status: 'FAIL' as const } } },
  ])('keeps $label non-PASS without retrying', async ({ output }) => {
    const port = fakePort(output);
    const result = await verifyResultLive({ ...observeInput, executionPort: port });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.status).not.toBe('passed');
    expect(port.execute).toHaveBeenCalledOnce();
  });

  it('keeps static plan validation separate from a completed read-back', () => {
    const result = verifyResult({ plan });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('dry');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((check) => check.status === 'pending')).toBe(true);
  });

  it('keeps the MCP consumer on the static pending-checklist contract', async () => {
    const { operatorSessionToolCatalog } = await import('../apps/mcp-server/src/operator-session-tool-catalog.js');
    const entry = operatorSessionToolCatalog.find(([name]) => name === 'sangfor_verify_result');
    if (!entry) throw new Error('static verifier tool missing');
    const result = await entry[1].handler({ plan });
    expect(result).toMatchObject({ ok: true, mode: 'dry', checks: [{ status: 'pending' }] });
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
      const result = await verifyResultLive({ ...observeInput, mode: 'apply', executionPort: port });
      expect(result.ok).toBe(false);
      expect(result.checks[0]?.status).not.toBe('passed');
    } finally {
      if (previous === undefined) delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
      else process.env.SANGFOR_ALLOW_REAL_EXECUTION = previous;
    }
  });
});
