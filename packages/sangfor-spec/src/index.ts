/**
 * @sangfor/spec — IntendedSpec: the single data contract shared by the advisory
 * services (guide / verify / diagnose). A spec declares what a correct config
 * looks like; evaluateSpec() compares it to an observed config and produces
 * PASS / FAIL / INDETERMINATE verdicts.
 *
 * Safety principle (fixes the verifier false-pass class of bug):
 *   INDETERMINATE is NEVER counted as PASS, and overall `ok` requires positive
 *   evidence (at least one PASS, zero FAIL, zero INDETERMINATE).
 *
 * Public surface only — implementation lives in the focused modules below.
 */

export { normalizeSpecProduct } from './product.js';
export { listSpecCoverage, loadSpec } from './loader.js';
export { evaluateSpec } from './evaluate.js';
export { renderAdvisoryReport } from './report-markdown.js';
export { renderAdvisoryReportDocx } from './report-docx.js';
export type {
  Category,
  Citation,
  CompareOp,
  CoverageInfo,
  EvaluateOptions,
  EvaluationResult,
  EvaluationSummary,
  IntendedSpec,
  ItemResult,
  ObservedFact,
  ObservedSource,
  ProductCode,
  Severity,
  SpecItem,
  Verdict,
} from './types.js';
