import { validateConfigPlan } from '@sangfor/planner';
import type { ConfigPlan, ConfigStep } from '../../shared/src/index.js';
import { nowId } from '../../shared/src/index.js';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../../sangfor-browser-contracts/src/index.js';

export interface VerifyInput {
  plan: ConfigPlan;
  observed?: Record<string, unknown>;
  targetUrl?: string;
  product?: string;
  version?: string;
  credentials?: { username: string; password: string };
  mode?: 'dry' | 'observe' | 'apply';
  evidenceDir?: string;
  captchaOcrEndpoint?: string;
}

export interface VerificationCheck {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'manual_required';
  message: string;
  screenshotPath?: string;
  pageSnapshot?: string;
  fieldValues?: Record<string, string>;
  error?: string;
}

export interface VerificationResult {
  planId: string;
  ok: boolean;
  planErrors: string[];
  checks: VerificationCheck[];
  mode: string;
  durationMs: number;
  browser?: string;
}

export function computeLiveVerificationOk(checks: VerificationCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.status === 'passed');
}

export function verificationCheckFromBrowserResult(
  step: Pick<ConfigStep, 'id' | 'title'>,
  result: BrowserExecutionResult,
  expectedRequestId: string,
): VerificationCheck {
  const boundReadBack = result.requestId === expectedRequestId && result.mutationAttempted === false;
  const passed = boundReadBack && result.status === 'PASS' && result.readBack?.status === 'PASS';
  const failed = boundReadBack && (result.status === 'FAIL' || result.readBack?.status === 'FAIL');
  return {
    id: step.id,
    title: step.title,
    status: passed ? 'passed' : failed ? 'failed' : 'manual_required',
    message: !boundReadBack
      ? 'Browser response is not a fresh read-only verification result.'
      : passed
        ? 'Fresh browser read-back passed.'
        : result.error?.message ?? `Browser read-back result: ${result.status}.`,
    screenshotPath: result.evidence[0]?.artifactRef,
    pageSnapshot: result.observations ? JSON.stringify(result.observations) : undefined,
    error: failed ? result.error?.message ?? 'Browser read-back failed.' : undefined,
  };
}

export function verifyResult(input: VerifyInput): VerificationResult {
  const startMs = Date.now();
  const mode = input.mode ?? 'dry';
  if (mode === 'apply' && process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Apply mode requires SANGFOR_ALLOW_REAL_EXECUTION=true');
  }
  const planValidation = validateConfigPlan(input.plan);
  const checks: VerificationCheck[] = input.plan.validationPlan.map((step) => ({
    id: step.id,
    title: step.title,
    status: 'pending',
    message: `Mode=${mode}: validation deferred to a BrowserExecutionPort read-back.`,
  }));
  return {
    planId: input.plan.id,
    ok: planValidation.ok,
    planErrors: planValidation.errors,
    checks,
    mode,
    durationMs: Date.now() - startMs,
  };
}

export async function verifyResultLive(
  input: VerifyInput & {
    sessionId?: string;
    executionPort?: BrowserExecutionPort;
  },
): Promise<VerificationResult> {
  const startMs = Date.now();
  const mode = input.mode ?? 'dry';
  if (mode === 'apply' && process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Apply mode requires SANGFOR_ALLOW_REAL_EXECUTION=true');
  }
  if (!input.executionPort) {
    throw new Error('BROWSER_EXECUTION_PORT_REQUIRED: live verification requires JM runtime composition.');
  }
  if (!input.sessionId) {
    throw new Error('Browser execution port verification requires sessionId.');
  }
  const planValidation = validateConfigPlan(input.plan);
  const targetUrl = input.targetUrl
    ?? `http://${process.env.SANGFOR_EQUIPMENT_HOST ?? '10.80.1.106'}:${process.env.SANGFOR_EQUIPMENT_PORT ?? '443'}/hci`;
  const checks: VerificationCheck[] = [];
  // A passing observation cannot repair an invalid plan.
  const validationSteps = planValidation.ok ? input.plan.validationPlan : [];
  for (const step of validationSteps) {
    if (!step.references?.length) {
      checks.push({
        id: step.id,
        title: step.title,
        status: 'skipped',
        message: 'No references — skipped',
      });
      continue;
    }
    const requestId = nowId('browser-verify');
    const result = await input.executionPort.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId,
      sessionId: input.sessionId,
      origin: new URL(targetUrl).origin,
      operation: {
        kind: 'verify_console',
        checks: [{
          id: step.id,
          kind: 'text_contains',
          expected: step.title,
        }],
      },
    });
    checks.push(verificationCheckFromBrowserResult(step, result, requestId));
  }
  return {
    planId: input.plan.id,
    ok: planValidation.ok && computeLiveVerificationOk(checks),
    planErrors: planValidation.errors,
    checks,
    mode,
    durationMs: Date.now() - startMs,
  };
}
