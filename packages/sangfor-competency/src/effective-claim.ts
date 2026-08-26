import { createHash } from 'node:crypto';
import { validateAndPersistEvidenceStaleness } from './evidence-invalidation.js';
import { nodeEvidenceFilesystem } from './evidence-filesystem.js';
import type { EvidenceFilesystem, EvidenceValidationContext, EvidenceValidationIssueCode } from './evidence-validation-types.js';
import {
  hasStalePromotionManifest,
  maskedPromotionRef,
  samePromotionTarget,
  type PromotionLedger,
  type PromotionLedgerEvent,
} from './promotion-ledger.js';
import { deriveEffectiveMaturity } from './promotion-preflight.js';
import { MATURITY_RANK, type Maturity, type WorkAtom } from './schema.js';
import { violation, type CoverageViolation } from './violations.js';
import type { parseGroundedCapabilityEvidence } from './evidence-grounding.js';

export type EffectiveEvidenceClaim = {
  readonly manifestSource: string;
  readonly evidenceRoot: string;
  readonly filesystem?: EvidenceFilesystem;
  readonly context: EvidenceValidationContext;
};

export type EffectiveParsedClaim = {
  readonly source: EffectiveEvidenceClaim;
  readonly manifest: ReturnType<typeof parseGroundedCapabilityEvidence>;
};

export type EffectiveClaimIssue = {
  readonly atomId: string;
  readonly state: 'stale' | 'demoted' | 'unverified';
  readonly effectiveMaturity: Maturity;
  readonly evidenceIssueCodes: readonly EvidenceValidationIssueCode[];
};

export type EffectiveClaimEvaluationInput = {
  readonly claim: EffectiveParsedClaim;
  readonly atom: WorkAtom;
  readonly baseline: Maturity;
  readonly events: readonly PromotionLedgerEvent[];
  readonly ledger: PromotionLedger;
};

type ClaimEvaluation = {
  readonly replaced: boolean;
  readonly issue?: EffectiveClaimIssue;
  readonly violations: readonly CoverageViolation[];
};

function inactiveMaturity(maturity: Maturity): Maturity {
  return MATURITY_RANK[maturity] < MATURITY_RANK.tested_mock ? maturity : 'tested_mock';
}

export async function evaluateEffectiveClaim(input: EffectiveClaimEvaluationInput): Promise<ClaimEvaluation> {
  const { claim, atom, baseline, events } = input;
  const staleness = await validateAndPersistEvidenceStaleness({
    manifestSource: claim.source.manifestSource,
    manifest: claim.manifest,
    evidenceRoot: claim.source.evidenceRoot,
    filesystem: claim.source.filesystem ?? nodeEvidenceFilesystem(),
    context: claim.source.context,
    baseline,
    ledger: input.ledger,
  });
  if (staleness.status === 'refused') {
    return {
      replaced: false,
      violations: [violation('activeEvidenceUnavailable', atom.id, `evidence validation refused: ${staleness.issues.map(({ code }) => code).join(',')}`)],
    };
  }
  if (staleness.status === 'indeterminate') {
    return { replaced: false, violations: [violation('promotionLedgerUnavailable', atom.id, `stale evidence boundary is ${staleness.reason}`)] };
  }

  const targetEvents = events.filter((event) => event.outcome === 'applied' && samePromotionTarget(event.target, claim.manifest.target));
  let ledgerMaturity: Maturity;
  try {
    ledgerMaturity = deriveEffectiveMaturity(baseline, claim.manifest.target, events);
  } catch {
    return { replaced: false, violations: [violation('promotionLedgerUnavailable', null, 'authenticated promotion event state is inconsistent')] };
  }
  if (staleness.status === 'applied') {
    return {
      replaced: false,
      issue: {
        atomId: atom.id,
        state: 'stale',
        effectiveMaturity: inactiveMaturity(ledgerMaturity),
        evidenceIssueCodes: staleness.issues.map(({ code }) => code),
      },
      violations: [],
    };
  }

  const manifestDigest = createHash('sha256').update(claim.source.manifestSource, 'utf8').digest('hex');
  const currentManifestRef = maskedPromotionRef('manifest', manifestDigest);
  const latestDemotion = [...targetEvents].reverse().find(({ action }) => action === 'emergency_demote');
  const latestEvent = targetEvents.at(-1);
  const staleManifest = hasStalePromotionManifest(events, claim.manifest.target, currentManifestRef);
  const currentPromotion = latestEvent?.action === 'promote' && latestEvent.manifestRef === currentManifestRef;
  const reusedAfterDemotion = currentPromotion && latestDemotion !== undefined
    && latestDemotion.manifestRef === currentManifestRef;

  if (latestEvent?.action === 'stale' && latestEvent.manifestRef === currentManifestRef) {
    return {
      replaced: false,
      issue: {
        atomId: atom.id,
        state: 'stale',
        effectiveMaturity: ledgerMaturity,
        evidenceIssueCodes: latestEvent.invalidation === undefined ? [] : [latestEvent.invalidation.reason],
      },
      violations: [],
    };
  }
  if (latestEvent?.action === 'emergency_demote') {
    return {
      replaced: false,
      issue: { atomId: atom.id, state: 'demoted', effectiveMaturity: ledgerMaturity, evidenceIssueCodes: [] },
      violations: [],
    };
  }
  if (currentPromotion && !staleManifest && !reusedAfterDemotion && ledgerMaturity === 'field_verified') {
    return { replaced: true, violations: [] };
  }
  return {
    replaced: false,
    issue: {
      atomId: atom.id,
      state: 'unverified',
      effectiveMaturity: reusedAfterDemotion && latestDemotion !== undefined
        ? latestDemotion.toMaturity
        : inactiveMaturity(baseline),
      evidenceIssueCodes: [],
    },
    violations: [],
  };
}
