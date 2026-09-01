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
}

export interface EvaluateOptions {
  /** Evaluation time for freshness checks. Defaults to wall clock. */
  now?: string | Date;
}
