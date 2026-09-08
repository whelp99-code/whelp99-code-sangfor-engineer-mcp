import { canonicalizeApprovalPayload, signDomainApproval } from '../../sangfor-approval/src/index.js';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { CapabilityEvidenceGroundingError } from './evidence-grounding.js';
import { maskedPromotionRef, PromotionLedgerUnavailableError, type PromotionLedgerEvent, type PromotionLedgerEventInput } from './promotion-ledger.js';
import type { CapabilityPromotionEnvelope } from './promotion-schema.js';
import { MATURITY_RANK, type Maturity } from './schema.js';

const APPROVAL_DOMAIN = 'sangfor.capability-maturity-decision.v1';
export const CAPABILITY_SIGNATURE = /^[a-f0-9]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new PromotionLedgerUnavailableError();
  return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function canonicalizeCapabilityApproval(envelope: CapabilityPromotionEnvelope): string {
  const decision = envelope.decision;
  if (decision === null) return canonicalizeApprovalPayload([APPROVAL_DOMAIN, canonical(envelope.request), 'null']);
  const { approvalDigest: _approvalDigest, ...unsignedDecision } = decision;
  return canonicalizeApprovalPayload([APPROVAL_DOMAIN, canonical(envelope.request), canonical(unsignedDecision)]);
}

export function signCapabilityApproval(secret: string, canonicalPayload: string): string {
  return Buffer.from(signDomainApproval(secret, canonicalPayload)).toString('hex');
}

function sameTarget(left: PromotionLedgerEvent['target'], right: PromotionLedgerEvent['target']): boolean {
  return left.productId === right.productId && left.capabilityId === right.capabilityId && left.toolId === right.toolId
    && left.workAtomIds.length === right.workAtomIds.length
    && left.workAtomIds.every((id, index) => id === right.workAtomIds[index]);
}

export function deriveEffectiveMaturity(
  baseline: Maturity,
  target: PromotionLedgerEvent['target'],
  events: readonly PromotionLedgerEvent[],
): Maturity {
  let maturity = baseline;
  for (const event of events) {
    if (event.outcome !== 'applied' || !sameTarget(event.target, target)) continue;
    if (event.fromMaturity !== maturity) throw new PromotionLedgerUnavailableError();
    maturity = event.toMaturity;
  }
  return maturity;
}

export function promotionEventInput(
  envelope: CapabilityPromotionEnvelope,
  maturity: Maturity,
  outcome: 'applied' | 'rejected',
  refusalCode: string | null,
  now: Date,
): PromotionLedgerEventInput {
  const decision = envelope.decision;
  const decisionId = decision?.decisionId ?? envelope.request.requestId;
  let destination = maturity;
  if (outcome === 'applied' && decision?.decision === 'promote') destination = decision.promotedMaturity;
  if (outcome === 'applied' && decision?.decision === 'emergency_demote') destination = decision.demotedMaturity;
  return {
    version: 1,
    eventId: `event-${maskedPromotionRef('event', `${decisionId}:${now.toISOString()}`).slice(0, 24)}`,
    at: now.toISOString(),
    outcome,
    action: decision?.decision ?? 'reject',
    target: envelope.request.target,
    fromMaturity: maturity,
    toMaturity: destination,
    decisionRef: maskedPromotionRef('decision', decisionId),
    manifestRef: maskedPromotionRef('manifest', envelope.request.manifestDigest),
    nonceRef: decision?.nonce === undefined ? null : maskedPromotionRef('nonce', decision.nonce),
    refusalCode,
  };
}

export function promotionTransitionCode(envelope: CapabilityPromotionEnvelope, current: Maturity): string | undefined {
  const decision = envelope.decision;
  if (decision === null) return 'missing_decision';
  switch (decision.decision) {
    case 'reject': return 'human_rejected';
    case 'promote':
      return MATURITY_RANK[decision.promotedMaturity] === MATURITY_RANK[current] + 1 ? undefined : 'non_adjacent_transition';
    case 'emergency_demote':
      return MATURITY_RANK[decision.demotedMaturity] < MATURITY_RANK[current] ? undefined : 'invalid_emergency_demotion';
    default:
      decision satisfies never;
      return 'invalid_decision';
  }
}

export function promotionParseFailureCode(error: unknown): string {
  if (error instanceof CapabilityEvidenceGroundingError) return error.issues[0]?.code ?? 'grounding_refused';
  if (error instanceof RuntimeSchemaError) return 'invalid_payload';
  return 'invalid_payload';
}
