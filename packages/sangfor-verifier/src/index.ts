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
): VerificationCheck {
  const passed = result.status === 'PASS' && result.readBack?.status === 'PASS';
  const failed = result.status === 'FAIL' || result.readBack?.status === 'FAIL';
  return {
    id: step.id,
    title: step.title,
    status: passed ? 'passed' : failed ? 'failed' : 'manual_required',
    message: passed
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
  for (const step of input.plan.validationPlan ?? []) {
    if (!step.references?.length) {
      checks.push({
        id: step.id,
        title: step.title,
        status: 'skipped',
        message: 'No references — skipped',
      });
      continue;
    }
    const result = await input.executionPort.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: nowId('browser-verify'),
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
    checks.push(verificationCheckFromBrowserResult(step, result));
  }
  return {
    planId: input.plan.id,
    ok: computeLiveVerificationOk(checks),
    planErrors: planValidation.errors,
    checks,
    mode,
    durationMs: Date.now() - startMs,
  };
}
