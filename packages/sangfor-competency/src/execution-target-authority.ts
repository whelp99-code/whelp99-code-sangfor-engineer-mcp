import { createHmac, timingSafeEqual } from 'node:crypto';

export type ExecutionTargetClassificationInput = {
  readonly environment: 'lab' | 'production';
  readonly product: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly campaignId: string;
  readonly deviceIdentityDigest: string;
  readonly originDigest: string;
  readonly firmwareTruthDigest: string;
  readonly recipeDigest: string;
  readonly toolDigest: string;
  readonly runtimeDigest: string;
  readonly windowIdentityDigest: string;
};

const CLASSIFICATION_DOMAIN = 'sangfor.execution-target-classification.v1';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

function classificationPayload(input: ExecutionTargetClassificationInput): string {
  return JSON.stringify([
    CLASSIFICATION_DOMAIN,
    input.environment,
    input.product,
    input.capabilityId,
    input.toolId,
    input.campaignId,
    input.deviceIdentityDigest,
    input.originDigest,
    input.firmwareTruthDigest,
    input.recipeDigest,
    input.toolDigest,
    input.runtimeDigest,
    input.windowIdentityDigest,
  ]);
}

export function signExecutionTargetClassification(
  secret: string,
  input: ExecutionTargetClassificationInput,
): string {
  if (secret.length === 0) throw new TypeError('execution target authority secret required');
  return createHmac('sha256', secret).update(classificationPayload(input), 'utf8').digest('hex');
}

export function verifyExecutionTargetClassification(
  secret: string | undefined,
  input: ExecutionTargetClassificationInput,
  token: string,
): boolean {
  if (secret === undefined || secret.length === 0 || !TOKEN_PATTERN.test(token)) return false;
  const expected = signExecutionTargetClassification(secret, input);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
}
