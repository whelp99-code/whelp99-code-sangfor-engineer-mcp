import { createHash } from 'node:crypto';
import type { CapabilityEvidenceManifest } from './evidence-schema.js';
import type {
  EvidenceFilesystem,
  EvidenceValidationContext,
  EvidenceValidationIssue,
  EvidenceValidationResult,
} from './evidence-validation-types.js';
import { validateCapabilityEvidence } from './evidence-validation.js';
import {
  maskedPromotionRef,
  samePromotionTarget,
  type PromotionLedger,
  type PromotionLedgerEvent,
} from './promotion-ledger.js';
import { deriveEffectiveMaturity } from './promotion-preflight.js';
import { MATURITY_RANK, type Maturity } from './schema.js';

type ComputedStaleValidation = Extract<EvidenceValidationResult, { readonly status: 'stale' }>;

export type ValidateAndPersistEvidenceStalenessInput = {
  readonly manifestSource: string;
  readonly manifest: CapabilityEvidenceManifest;
  readonly evidenceRoot: string;
  readonly filesystem: EvidenceFilesystem;
  readonly context: EvidenceValidationContext;
  readonly baseline: Maturity;
  readonly ledger: PromotionLedger;
};

export type ValidateAndPersistEvidenceStalenessResult =
  | { readonly status: 'applied'; readonly event: PromotionLedgerEvent; readonly issues: readonly EvidenceValidationIssue[] }
  | { readonly status: 'no_change'; readonly evidenceStatus: 'active' }
  | { readonly status: 'refused'; readonly evidenceStatus: 'refused'; readonly issues: readonly EvidenceValidationIssue[] }
  | { readonly status: 'indeterminate'; readonly reason: 'validation_unavailable' | 'ledger_state_unknown' | 'ledger_commit_unknown' };

type AppendStaleEvidenceInput = ValidateAndPersistEvidenceStalenessInput & {
  readonly validation: ComputedStaleValidation;
};

function inactiveMaturity(maturity: Maturity): Maturity {
  return MATURITY_RANK[maturity] < MATURITY_RANK.tested_mock ? maturity : 'tested_mock';
}

async function appendStaleEvidenceInvalidation(
  input: AppendStaleEvidenceInput,
): Promise<ValidateAndPersistEvidenceStalenessResult> {
  let events: readonly PromotionLedgerEvent[];
  try {
    events = await input.ledger.read();
  } catch {
    return { status: 'indeterminate', reason: 'ledger_state_unknown' };
  }

  const manifestDigest = createHash('sha256').update(input.manifestSource, 'utf8').digest('hex');
  const manifestRef = maskedPromotionRef('manifest', manifestDigest);
  const existing = events.find((event) => event.outcome === 'applied' && event.action === 'stale'
    && samePromotionTarget(event.target, input.manifest.target) && event.manifestRef === manifestRef);
  if (existing !== undefined) return { status: 'applied', event: existing, issues: input.validation.issues };

  let maturity: Maturity;
  try {
    maturity = deriveEffectiveMaturity(input.baseline, input.manifest.target, events);
  } catch {
    return { status: 'indeterminate', reason: 'ledger_state_unknown' };
  }
  const observedAt = input.context.clock.now().toISOString();
  const reason = input.validation.issues.some(({ code }) => code === 'identity_drift')
    ? 'identity_drift' as const
    : 'evidence_expired' as const;
  const observedIdentityRef = maskedPromotionRef('stale-observation', JSON.stringify({
    observedAt,
    reason,
    issues: input.validation.issues,
    currentFirmware: input.context.currentFirmware,
    currentDigests: input.context.currentDigests,
  }));
  try {
    const event = await input.ledger.append({
      version: 1,
      eventId: `stale-${maskedPromotionRef('stale-event', `${manifestRef}:${observedAt}`).slice(0, 24)}`,
      at: observedAt,
      outcome: 'applied',
      action: 'stale',
      target: input.manifest.target,
      fromMaturity: maturity,
      toMaturity: inactiveMaturity(maturity),
      decisionRef: observedIdentityRef,
      manifestRef,
      nonceRef: null,
      refusalCode: null,
      invalidation: { reason, observedIdentityRef },
    });
    return { status: 'applied', event, issues: input.validation.issues };
  } catch {
    return { status: 'indeterminate', reason: 'ledger_commit_unknown' };
  }
}

export async function validateAndPersistEvidenceStaleness(
  input: ValidateAndPersistEvidenceStalenessInput,
): Promise<ValidateAndPersistEvidenceStalenessResult> {
  let validation: EvidenceValidationResult;
  let context: EvidenceValidationContext;
  try {
    const observedAt = input.context.clock.now();
    context = { ...input.context, clock: { now: () => observedAt } };
    validation = validateCapabilityEvidence({
      manifest: input.manifest,
      evidenceRoot: input.evidenceRoot,
      filesystem: input.filesystem,
      context,
    });
  } catch {
    return { status: 'indeterminate', reason: 'validation_unavailable' };
  }
  switch (validation.status) {
    case 'active':
      return { status: 'no_change', evidenceStatus: 'active' };
    case 'refused':
      return { status: 'refused', evidenceStatus: 'refused', issues: validation.issues };
    case 'stale':
      return appendStaleEvidenceInvalidation({ ...input, context, validation });
    default:
      validation satisfies never;
      return { status: 'indeterminate', reason: 'validation_unavailable' };
  }
}
