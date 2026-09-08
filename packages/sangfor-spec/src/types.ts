/**
 * IntendedSpec data contract — the shapes shared by the advisory services
 * (guide / verify / diagnose) and by every downstream consumer.
 *
 * Safety principle (fixes the verifier false-pass class of bug):
 *   INDETERMINATE is NEVER counted as PASS, and overall `ok` requires positive
 *   evidence (at least one PASS, zero FAIL, zero INDETERMINATE).
 */

export type CompareOp = 'eq' | 'neq' | 'gte' | 'lte' | 'includes' | 'oneOf' | 'exists';
export type Severity = 'must' | 'recommended';
export type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export type Category = 'ok' | 'misconfiguration' | 'missing' | 'indeterminate' | 'context_dependent';
export type ProductCode = 'HCI_SCP' | 'HCI' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR' | 'CYBER_COMMAND' | 'FORTIOS' | 'CISCO_IOSXE';
/** Stable machine-readable cause for an advisory follow-up. The existing
 * human-readable `reason` remains the explanation shown to users. */
export type AssessmentReasonCode =
  | 'ASSESSMENT_TIME_MISSING' | 'ASSESSMENT_TIME_INVALID'
  | 'FRESHNESS_POLICY_MISSING' | 'FRESHNESS_POLICY_INVALID'
  | 'EVIDENCE_EXPIRED' | 'EVIDENCE_MISSING' | 'EVIDENCE_FUTURE'
  | 'COLLECTION_INCOMPLETE' | 'COLLECTION_UNPROVEN'
  | 'OBSERVED_VALUE_MISSING' | 'OBSERVED_VALUE_INCOMPATIBLE'
  | 'SENIOR_REVIEW_REQUIRED' | 'CONFIRMED_FAIL';
export type AssessmentActionCode =
  | 'SET_FRESHNESS_POLICY' | 'RECOLLECT_OBSERVATION' | 'COMPLETE_COLLECTION'
  | 'OBSERVE_REQUIRED_VALUE' | 'NORMALIZE_OBSERVED_VALUE' | 'SET_ASSESSMENT_TIME'
  | 'REQUEST_SENIOR_REVIEW' | 'REVIEW_CONFIRMED_FAIL';
/** Advisory only. This contract never starts collection or changes a device. */
export interface AssessmentNextAction {
  code: AssessmentActionCode;
  label: string;
  /** Present only on an aggregate EvaluationResult action. */
  itemIds?: string[];
}
export interface ActionableReason {
  code: AssessmentReasonCode;
  /** Present only on an aggregate EvaluationResult reason. */
  itemIds?: string[];
}

export interface Citation {
  manual: string;
  section?: string;
  page?: string;
}

export interface SpecItem {
  id: string;
  capabilityId: string;
  label: string;
  observedKey: string;
  op: CompareOp;
  expected?: unknown;
  severity: Severity;
  source?: Citation;
  needsSeniorReview?: boolean;
  /** A deviating value may be an intended choice given the customer environment
   *  (size, segmentation, compliance, business apps). Such a FAIL is classified
   *  'context_dependent' — never asserted as a misconfiguration — pending human review. */
  contextDependent?: boolean;
  /** A1 freshness SLO: maximum age (seconds) of the observed evidence for this key.
   *  Declared budgets can only DEMOTE a would-be PASS to INDETERMINATE
   *  ('evidence-expired') when the evidence is older than the budget, missing its
   *  collectedAt, or unparseable. FAIL is never masked; undeclared keys are unchanged. */
  maxAgeSec?: number;
}

export interface IntendedSpec {
  id: string;
  product: string;
  version?: string;
  items: SpecItem[];
}

export interface ObservedSource {
  endpoint?: string;    // e.g. 'POST /api/edrgoweb/v1/patch/statistics'
  collectedAt?: string; // ISO timestamp of capture
  collector?: string;   // e.g. 'live-xhr' | 'dom-scrape' | 'aside-snapshot'
  collectionStatus?: 'complete' | 'partial' | 'failed';
}

/** An observed value that carries its own provenance. evaluateSpec accepts either
 *  a bare value or this wrapper per observedKey. */
export interface ObservedFact {
  value: unknown;
  source?: ObservedSource;
}

export interface ItemResult {
  id: string;
  label: string;
  verdict: Verdict;
  category: Category;
  observed?: unknown;
  observedSource?: ObservedSource;
  expected?: unknown;
  reason: string;
  /** Stable counterpart to `reason`, supplied when human follow-up is known. */
  actionableReason?: ActionableReason;
  /** Read-only advisory follow-up; no collection or mutation is performed. */
  nextActions?: AssessmentNextAction[];
}

export interface CoverageInfo {
  specifiedTotal: number;    // spec items
  observedTotal: number;     // observed keys supplied
  unspecifiedKeys: string[]; // observed keys with no matching spec item (audit targets — config present but not intended)
  unobservedItems: string[]; // spec item ids with no observed value (blind spots)
}

export interface EvaluationSummary {
  pass: number;
  fail: number;
  indeterminate: number;
  misconfiguration: number;
  missing: number;
  contextDependent: number;
}

export interface EvaluationResult {
  specId: string;
  ok: boolean;
  items: ItemResult[];
  summary: EvaluationSummary;
  coverage: CoverageInfo;
  /** De-duplicated machine-readable causes, with the affected spec item ids. */
  actionableReasons?: ActionableReason[];
  /** De-duplicated advisory follow-ups, with the affected spec item ids. */
  nextActions?: AssessmentNextAction[];
  assessment?: {
    mode: 'comparison' | 'current' | 'snapshot';
    evaluatedAt: string | null;
    freshnessRequired: boolean;
  };
}

export interface EvaluateOptions {
  /** Evaluation time for freshness checks. Defaults to wall clock. */
  now?: string | Date;
  /** Legacy value-only comparisons cannot claim current health. */
  mode?: 'comparison' | 'current' | 'snapshot';
  /** Explicit clock tolerance; default zero, never an implicit allowance for future evidence. */
  maxFutureSkewSec?: number;
}
