import { ConfigPlan, nowId } from '@sangfor/shared';

export interface EvalCase {
  id: string;
  name: string;
  product: string;
  requiredText: string;
}

const evalCases: EvalCase[] = [
  { id: 'eval_hci_mtu_precheck', name: 'HCI plan must include MTU precheck', product: 'HCI', requiredText: 'MTU' },
  { id: 'eval_iag_policy_export', name: 'IAG plan must export existing policy before applying changes', product: 'IAG', requiredText: 'Export' },
  { id: 'eval_es_pilot_group', name: 'Endpoint Secure plan must use pilot group rollout', product: 'ENDPOINT_SECURE', requiredText: 'pilot' },
  { id: 'eval_cc_ntp', name: 'Cyber Command plan must validate NTP/time consistency', product: 'CYBER_COMMAND', requiredText: 'NTP' }
];

export function createEvalCaseFromFeedback(input: { product: string; name: string; requiredText: string }): EvalCase {
  const evalCase = { id: nowId('eval'), ...input };
  evalCases.push(evalCase);
  return evalCase;
}

export function runPlannerEval(plan: ConfigPlan) {
  const text = JSON.stringify(plan).toLowerCase();
  const relevant = evalCases.filter(e => e.product === plan.product);
  return {
    ok: relevant.every(e => text.includes(e.requiredText.toLowerCase())),
    results: relevant.map(e => ({
      id: e.id,
      name: e.name,
      pass: text.includes(e.requiredText.toLowerCase()),
      requiredText: e.requiredText
    }))
  };
}
