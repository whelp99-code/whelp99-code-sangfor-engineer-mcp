import { ConfigPlan } from '@sangfor/shared';
import { validateConfigPlan } from '@sangfor/planner';

export function verifyResult(input: { plan: ConfigPlan; observed?: Record<string, unknown> }) {
  const planValidation = validateConfigPlan(input.plan);
  const checks = input.plan.validationPlan.map(item => ({
    id: item.id,
    title: item.title,
    status: 'pending_manual_validation',
    message: 'MVP does not connect to real Sangfor device. Validate manually or in lab runner.'
  }));
  return {
    ok: planValidation.ok,
    planErrors: planValidation.errors,
    checks
  };
}
