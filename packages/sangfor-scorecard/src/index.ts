/**
 * @sangfor/scorecard — Phase 5 governor surfaces (design 002, blocks G4, G2, G3, H1, E3).
 *
 * L1 package: imports only @sangfor/shared and @sangfor/chronicle. Everything is
 * pure or takes its inputs by injection — clocks, detectors, matchers, basis
 * tables and snapshot chains all arrive as arguments, so higher layers stay out
 * of this dependency graph and every result is reproducible from the ledger.
 */
export {
  autonomyAllowed,
  computeTier,
  pinTier,
  type AutonomyCapability,
  type PinnedTierResult,
  type ScorecardMetrics,
  type Tier,
  type TierBoundary,
  type TierPin,
  type TierPinLedgerEntry,
  type TierResult,
  type TierState,
  type TierThresholds,
} from './scorecard.js';
export {
  activationDecision,
  recordHumanAction,
  recordShadowRun,
  shadowAgreement,
  type ActivationPolicy,
  type HumanActionEntry,
  type RecordHumanActionInput,
  type RecordShadowRunInput,
  type ShadowAction,
  type ShadowAgreementResult,
  type ShadowDisagreement,
  type ShadowMatcher,
  type ShadowRunEntry,
} from './shadow.js';
export {
  DRILL_SCENARIOS,
  getDrillScenario,
  runDrill,
  type DrillDetectors,
  type DrillDossier,
  type DrillExpectation,
  type DrillGap,
  type DrillResult,
  type DrillScenario,
  type DrillScenarioId,
} from './drill.js';
export {
  queryDevices,
  type NoDataReason,
  type QueryChains,
  type QueryDevicesInput,
  type QueryDevicesResult,
  type QueryMatch,
  type QueryNoData,
  type QueryOp,
  type QueryPredicate,
  type QuerySnapshot,
} from './query.js';
export {
  TIME_SAVED_KINDS,
  recordTimeSaved,
  summarizeTimeSaved,
  type RecordTimeSavedInput,
  type TimeSavedBasisTable,
  type TimeSavedEntry,
  type TimeSavedKind,
  type TimeSavedKindTotal,
  type TimeSavedSummary,
  type TimeSavedWindow,
} from './time-saved.js';
