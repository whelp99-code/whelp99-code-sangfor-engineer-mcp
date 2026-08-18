/**
 * @sangfor/intent-graph — device relationship graph and blast-radius triage
 * (design 002, blocks D1, D2).
 *
 * L1 package: pure functions over injected observed facts, rules and clocks.
 * Verdicts always come from @sangfor/spec's evaluateSpec — this package only
 * assembles cross-device evidence and applies demotion-only safety rules.
 */
export {
  deriveEdges,
  type DeriveEdgesOptions,
  type EdgeEvidence,
  type EdgeKind,
  type EdgeProvenance,
  type EdgeRule,
  type IntentEdge,
  type IntentGraph,
  type IntentNode,
  type RuleDevice,
} from './graph.js';
export {
  assembleCrossDeviceObserved,
  evaluateCrossDeviceSpec,
  type AssembledCrossDeviceObserved,
  type CrossDeviceKeyMap,
  type CrossDeviceKeySource,
} from './cross-spec.js';
export {
  blastRadius,
  prioritize,
  type Finding,
  type FindingSeverity,
  type PrioritizeOptions,
  type PrioritizeResult,
  type PrioritizedFinding,
} from './blast.js';
