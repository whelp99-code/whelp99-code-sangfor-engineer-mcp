import { ApprovalDecision, ConsoleAction, RiskLevel } from '@sangfor/shared';

const DANGEROUS_TERMS = [
  'apply', 'save', 'delete', 'remove', 'reboot', 'restart', 'shutdown',
  'failover', 'migration start', 'cutover', 'enable policy', 'activate license',
  'password', 'otp', 'mfa', 'production', 'format', 'drop', 'factory reset',
  'agent deployment', 'endpoint isolation', 'isolate endpoint', 'soar response',
  'response action', 'route change', 'nat change', 'interface change',
  'vm power', 'power off', 'power on', 'vm migrate', 'vm delete',
  'security policy', 'policy change'
];

export function classifyTextRisk(text: string): RiskLevel {
  const value = text.toLowerCase();
  if (['delete', 'shutdown', 'factory reset', 'drop', 'format', 'endpoint isolation', 'isolate endpoint', 'soar response', 'response action', 'vm delete'].some(term => value.includes(term))) return 'critical';
  if (DANGEROUS_TERMS.some(term => value.includes(term))) return 'high';
  if (['network', 'policy', 'storage', 'migration', 'route', 'nat', 'interface'].some(term => value.includes(term))) return 'medium';
  return 'low';
}

export function requiresApprovalForText(text: string): ApprovalDecision {
  const riskLevel = classifyTextRisk(text);
  return {
    required: riskLevel === 'high' || riskLevel === 'critical',
    riskLevel,
    reason: riskLevel === 'high' || riskLevel === 'critical'
      ? 'This operation may change production configuration or cause service impact.'
      : 'No approval required for read-only or planning operation.'
  };
}

export function requiresApprovalForAction(action: ConsoleAction): ApprovalDecision {
  const joined = `${action.type} ${action.target ?? ''} ${action.value ?? ''}`;
  return requiresApprovalForText(joined);
}
