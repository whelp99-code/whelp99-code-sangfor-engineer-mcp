import { describe, expect, it } from 'vitest';
import {
  signExecutionTargetClassification,
  verifyExecutionTargetClassification,
  type ExecutionTargetClassificationInput,
} from '../packages/sangfor-competency/src/execution-target-authority.js';

const SECRET = 'execution-target-authority-secret-32-bytes';
const input = (): ExecutionTargetClassificationInput => ({
  environment: 'lab',
  product: 'IAG',
  capabilityId: 'internet_policy',
  toolId: 'iag_o1_evidence_campaign',
  campaignId: 'campaign-1',
  deviceIdentityDigest: '1'.repeat(64),
  originDigest: '2'.repeat(64),
  firmwareTruthDigest: '3'.repeat(64),
  recipeDigest: '4'.repeat(64),
  toolDigest: '5'.repeat(64),
  runtimeDigest: '6'.repeat(64),
  windowIdentityDigest: '7'.repeat(64),
});

describe('execution target classification authority', () => {
  it('verifies the exact domain-separated target classification', () => {
    const classification = input();
    const token = signExecutionTargetClassification(SECRET, classification);

    expect(verifyExecutionTargetClassification(SECRET, classification, token)).toBe(true);
  });

  it('refuses environment and implementation relabeling under the original token', () => {
    const classification = input();
    const token = signExecutionTargetClassification(SECRET, classification);

    expect(verifyExecutionTargetClassification(
      SECRET,
      { ...classification, environment: 'production' },
      token,
    )).toBe(false);
    expect(verifyExecutionTargetClassification(
      SECRET,
      { ...classification, runtimeDigest: '8'.repeat(64) },
      token,
    )).toBe(false);
  });

  it('refuses absent secrets and malformed tokens', () => {
    const classification = input();

    expect(verifyExecutionTargetClassification(undefined, classification, '0'.repeat(64))).toBe(false);
    expect(verifyExecutionTargetClassification(SECRET, classification, 'not-a-token')).toBe(false);
  });
});
