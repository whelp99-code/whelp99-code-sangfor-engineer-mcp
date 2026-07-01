import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyResult } from '../packages/sangfor-verifier/src/index.js';

const minimalPlan = {
  id: 'p1', steps: [], precheck: [], rollbackPlan: [], validationPlan: [],
  product: 'HCI', planTitle: '', planSummary: '', riskLevel: 'medium',
  customerName: '', approvalRequiredSteps: [], manualReferences: [],
  wikiReferences: [], lessonReferences: [],
} as any;

describe('verifyResult — apply-mode gate (retired static-token cleanup)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_OPERATOR_APPROVAL_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('still fails closed on apply mode without SANGFOR_ALLOW_REAL_EXECUTION', () => {
    expect(() => verifyResult({ plan: minimalPlan, mode: 'apply' })).toThrow(/SANGFOR_ALLOW_REAL_EXECUTION/);
  });

  it('does NOT throw because of the retired SANGFOR_OPERATOR_APPROVAL_TOKEN env', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_TOKEN = 'legacy-value'; // retired by the operator signed-approval change
    const result = verifyResult({ plan: minimalPlan, mode: 'apply' });
    expect(result.mode).toBe('apply');
  });
});
