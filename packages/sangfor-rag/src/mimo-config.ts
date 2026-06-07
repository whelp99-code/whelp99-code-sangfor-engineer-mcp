/** Xiaomi MiMo billing: pay-as-you-go (sk-*) vs Token Plan (tp-*). */
export type MimoBillingMode = 'payg' | 'token-plan';

export type MimoTokenPlanCluster = 'cn' | 'sgp' | 'ams';

const TOKEN_PLAN_BASE: Record<MimoTokenPlanCluster, string> = {
  cn: 'https://token-plan-cn.xiaomimimo.com/v1',
  sgp: 'https://token-plan-sgp.xiaomimimo.com/v1',
  ams: 'https://token-plan-ams.xiaomimimo.com/v1'
};

export function resolveMimoBillingMode(): MimoBillingMode {
  const explicit = process.env.SANGFOR_MIMO_BILLING?.trim().toLowerCase();
  if (explicit === 'token-plan' || explicit === 'token_plan') return 'token-plan';
  if (explicit === 'payg' || explicit === 'pay-as-you-go') return 'payg';
  const key = process.env.SANGFOR_MIMO_API_KEY?.trim() ?? '';
  if (key.startsWith('tp-')) return 'token-plan';
  return 'payg';
}

export function resolveMimoTokenPlanCluster(): MimoTokenPlanCluster {
  const raw = (process.env.SANGFOR_MIMO_TOKEN_PLAN_CLUSTER ?? 'sgp').trim().toLowerCase();
  if (raw === 'cn' || raw === 'china') return 'cn';
  if (raw === 'ams' || raw === 'eu' || raw === 'europe') return 'ams';
  return 'sgp';
}

/** OpenAI-compatible chat/embed base URL for MiMo rerank. */
export function resolveMimoBaseUrl(): string {
  if (process.env.SANGFOR_MIMO_BASE_URL?.trim()) {
    return process.env.SANGFOR_MIMO_BASE_URL.trim().replace(/\/$/, '');
  }
  if (resolveMimoBillingMode() === 'token-plan') {
    return TOKEN_PLAN_BASE[resolveMimoTokenPlanCluster()];
  }
  return 'https://api.xiaomimimo.com/v1';
}
