import { verifyDomainApprovalSignature } from '../../sangfor-approval/src/index.js';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import type { CapabilityEvidenceGrounding } from './evidence-grounding.js';
import {
  CapabilityEvidenceGroundingError,
  parseGroundedCapabilityEvidence,
  parseGroundedCapabilityPromotion,
} from './evidence-grounding.js';
import { nodeEvidenceFilesystem } from './evidence-filesystem.js';
import type { EvidenceFilesystem, EvidenceValidationContext } from './evidence-validation-types.js';
import { validateCapabilityEvidence } from './evidence-validation.js';
import {
  PromotionLedgerStaleEvidenceError,
  PromotionLedgerStaleStateError,
  PromotionLedgerUnavailableError,
  hasStalePromotionManifest,
  maskedPromotionRef,
  type PromotionLedger,
  type PromotionLedgerEvent,
} from './promotion-ledger.js';
import {
  CAPABILITY_SIGNATURE,
  canonicalizeCapabilityApproval,
  deriveEffectiveMaturity,
  promotionEventInput,
  promotionParseFailureCode,
  promotionTransitionCode,
  signCapabilityApproval,
} from './promotion-preflight.js';
import { capabilityPromotionEnvelopeSchema, type CapabilityPromotionEnvelope } from './promotion-schema.js';
import { promotionIndeterminate, type CapabilityPromotionResult } from './promotion-result.js';
import { MATURITIES, type Maturity } from './schema.js';

export interface PromotionNonceStore {
  consume(nonce: string, expiresAt: string, now: Date):
    { readonly ok: boolean; readonly reason?: string }
    | Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

type PromotionValidation = {
  readonly evidenceRoot: string;
  readonly filesystem?: EvidenceFilesystem;
  readonly context: EvidenceValidationContext;
};

export type ExecuteCapabilityPromotionInput = {
  readonly manifestSource: string;
  readonly promotionSource: string;
  readonly grounding: CapabilityEvidenceGrounding;
  readonly validation: PromotionValidation;
  readonly secret: string | undefined;
  readonly nonceStore: PromotionNonceStore | undefined;
  readonly ledger: PromotionLedger;
  readonly now: Date;
};

export {
  canonicalizeCapabilityApproval,
  deriveEffectiveMaturity,
  signCapabilityApproval,
  type CapabilityPromotionResult,
};

export async function executeCapabilityPromotion(input: ExecuteCapabilityPromotionInput): Promise<CapabilityPromotionResult> {
  let events: readonly PromotionLedgerEvent[];
  try { events = await input.ledger.read(); }
  catch { return promotionIndeterminate('ledger_state_unknown'); }
  let envelope: CapabilityPromotionEnvelope;
  try {
    envelope = parseGroundedCapabilityPromotion({
      manifestSource: input.manifestSource,
      promotionSource: input.promotionSource,
      grounding: input.grounding,
    });
  } catch (error) {
    if (!(error instanceof CapabilityEvidenceGroundingError) && !(error instanceof RuntimeSchemaError)) throw error;
    let ungrounded: unknown;
    try { ungrounded = JSON.parse(input.promotionSource); }
    catch { return { status: 'refused', effectiveMaturity: MATURITIES[0], refusalCode: 'invalid_payload' }; }
    const recovered = capabilityPromotionEnvelopeSchema.safeParse(ungrounded);
    if (!recovered.success) {
      return { status: 'refused', effectiveMaturity: MATURITIES[0], refusalCode: promotionParseFailureCode(error) };
    }
    const fallback = recovered.data;
    const fallbackBaseline = input.grounding.context.maturityByCapability
      .get(`${fallback.request.target.productId}::${fallback.request.target.capabilityId}`) ?? MATURITIES[0];
    let fallbackEffective: Maturity;
    try { fallbackEffective = deriveEffectiveMaturity(fallbackBaseline, fallback.request.target, events); }
    catch { return promotionIndeterminate('ledger_state_unknown'); }
    try {
      const refusalCode = promotionParseFailureCode(error);
      const event = await input.ledger.append(promotionEventInput(fallback, fallbackEffective, 'rejected', refusalCode, input.now));
      return { status: 'refused', effectiveMaturity: fallbackEffective, refusalCode, event };
    } catch (appendError) {
      if (appendError instanceof PromotionLedgerUnavailableError) return promotionIndeterminate('ledger_state_unknown');
      if (appendError instanceof Error) return promotionIndeterminate();
      throw appendError;
    }
  }
  const baseline = input.grounding.context.maturityByCapability
    .get(`${envelope.request.target.productId}::${envelope.request.target.capabilityId}`) ?? MATURITIES[0];
  let effective: Maturity;
  try { effective = deriveEffectiveMaturity(baseline, envelope.request.target, events); }
  catch { return promotionIndeterminate('ledger_state_unknown'); }

  const refuse = async (code: string): Promise<CapabilityPromotionResult> => {
    try {
      const event = await input.ledger.append(promotionEventInput(envelope, effective, 'rejected', code, input.now));
      return { status: 'refused', effectiveMaturity: effective, refusalCode: code, event };
    } catch (error) {
      if (error instanceof PromotionLedgerUnavailableError) return promotionIndeterminate('ledger_state_unknown');
      if (error instanceof Error) return promotionIndeterminate();
      throw error;
    }
  };

  const decision = envelope.decision;
  if (decision === null || decision.nonce === undefined || decision.expiresAt === undefined) return refuse('missing_approval_fields');
  if (input.secret === undefined || input.secret.length < 32) return refuse('approval_secret_unavailable');
  if (!CAPABILITY_SIGNATURE.test(decision.approvalDigest)) return refuse('invalid_signature');
  if (!Number.isFinite(input.now.getTime()) || input.now.getTime() > Date.parse(decision.expiresAt)) return refuse('approval_expired');
  if (input.now.getTime() < Date.parse(decision.decidedAt)) return refuse('approval_not_yet_valid');
  const signature = verifyDomainApprovalSignature(
    input.secret,
    canonicalizeCapabilityApproval(envelope),
    Buffer.from(decision.approvalDigest, 'hex'),
  );
  if (!signature.ok) return refuse('signature_mismatch');
  if (envelope.request.fromMaturity !== effective || decision.fromMaturity !== effective) return refuse('stale_maturity');
  if (decision.decision === 'promote' && hasStalePromotionManifest(
    events,
    envelope.request.target,
    maskedPromotionRef('manifest', envelope.request.manifestDigest),
  )) return refuse('stale_evidence_digest');
  const transition = promotionTransitionCode(envelope, effective);
  if (transition !== undefined) return refuse(transition);
  if (decision.decision === 'promote') {
    const parsedManifest = parseGroundedCapabilityEvidence({ source: input.manifestSource, grounding: input.grounding });
    const validation = validateCapabilityEvidence({
      manifest: parsedManifest,
      evidenceRoot: input.validation.evidenceRoot,
      filesystem: input.validation.filesystem ?? nodeEvidenceFilesystem(),
      context: input.validation.context,
    });
    if (validation.status !== 'active') return refuse(validation.issues[0]?.code ?? 'evidence_inactive');
  }
  if (input.nonceStore === undefined) return refuse('nonce_store_unavailable');
  let consumed;
  try { consumed = await input.nonceStore.consume(decision.nonce, decision.expiresAt, input.now); }
  catch { return refuse('nonce_store_unavailable'); }
  if (!consumed.ok) return refuse(consumed.reason?.includes('already used') ? 'nonce_replay' : 'nonce_store_unavailable');
  try {
    const event = await input.ledger.append(promotionEventInput(envelope, effective, 'applied', null, input.now));
    return { status: 'applied', effectiveMaturity: event.toMaturity, event };
  } catch (error) {
    if (error instanceof PromotionLedgerStaleEvidenceError) {
      let current: Maturity;
      try { current = deriveEffectiveMaturity(baseline, envelope.request.target, await input.ledger.read()); }
      catch { return promotionIndeterminate('ledger_state_unknown'); }
      try {
        const event = await input.ledger.append(promotionEventInput(envelope, current, 'rejected', 'stale_evidence_digest', input.now));
        return { status: 'refused', effectiveMaturity: current, refusalCode: 'stale_evidence_digest', event };
      } catch (appendError) {
        if (appendError instanceof Error) return promotionIndeterminate('ledger_state_unknown');
        throw appendError;
      }
    }
    if (error instanceof PromotionLedgerStaleStateError) {
      let current: Maturity;
      try { current = deriveEffectiveMaturity(baseline, envelope.request.target, await input.ledger.read()); }
      catch { return promotionIndeterminate('ledger_state_unknown'); }
      try {
        const event = await input.ledger.append(promotionEventInput(envelope, current, 'rejected', 'stale_maturity', input.now));
        return { status: 'refused', effectiveMaturity: current, refusalCode: 'stale_maturity', event };
      } catch (appendError) {
        if (appendError instanceof PromotionLedgerUnavailableError) return promotionIndeterminate('ledger_state_unknown');
        if (appendError instanceof Error) return promotionIndeterminate();
        throw appendError;
      }
    }
    if (error instanceof PromotionLedgerUnavailableError) return promotionIndeterminate('ledger_state_unknown');
    if (error instanceof Error) return promotionIndeterminate();
    throw error;
  }
}
