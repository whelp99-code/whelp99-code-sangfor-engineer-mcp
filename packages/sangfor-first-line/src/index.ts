/**
 * @sangfor/first-line — first-line response ladder (design 002, Phase 3).
 *
 * Four pure read/decide models with no IO and no device authority:
 *   B2 `envelope`   — hour-of-week quantile bands with incident windows excluded
 *                     and an honest cold-start verdict.
 *   B3 `timeline`   — config diffs x health events x approvals x findings merged
 *                     into one ordered read model that never hides clock skew.
 *   E1/E2 `escalation` — the detected -> corroborated -> enriched ->
 *                     (auto-resolved-observed | escalated) state machine, which
 *                     by construction holds no approval and triggers no write.
 *   F4 `verifier`   — deterministic adversarial checks that block a draft
 *                     carrying a hallucinated citation, fact or rollback target.
 *
 * L1 package: inputs are injected by the caller so nothing here reaches up into
 * chronicle storage, the approval spine or the agent layer.
 */
export {
  hourOfWeek,
  isWithinEnvelope,
  learnEnvelope,
  type Envelope,
  type EnvelopeBucket,
  type EnvelopeSample,
  type EnvelopeVerdict,
  type ExcludeWindow,
  type LearnEnvelopeOptions,
} from './envelope.js';
export {
  buildTimeline,
  type BuildTimelineInput,
  type OrderingConfidence,
  type TimelineApprovalInput,
  type TimelineDiffInput,
  type TimelineEntry,
  type TimelineFindingInput,
  type TimelineHealthEventInput,
  type TimelineKind,
} from './timeline.js';
export {
  advanceFinding,
  type AdvanceFindingInput,
  type AdvanceFindingResult,
  type ClearingEvidence,
  type Finding,
  type FindingEvent,
  type FindingLedgerEntry,
  type FindingState,
  type FlapPolicy,
  type LedgerReason,
} from './escalation.js';
export {
  verifyReportClaims,
  type VerifiableCitation,
  type VerifiableFact,
  type VerifiableReport,
  type VerificationCheck,
  type VerificationCheckName,
  type VerifyReportClaimsInput,
  type VerifyReportClaimsResult,
} from './verifier.js';
