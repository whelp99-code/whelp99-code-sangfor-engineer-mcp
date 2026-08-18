/**
 * @sangfor/engineer-report — EngineerReport contract + hash-chained ledger
 * (design 002, blocks F1 and G1).
 *
 * The agent tier's only write path into the audit record. Verdicts arrive from
 * `evaluateSpec` and are carried verbatim; `validateEngineerReport` is the gate
 * that refuses any report whose engine result was altered. Also hosts the
 * golden-corpus scrubber and fixture loader, since both exist to keep the same
 * engine output reproducible.
 *
 * L1 package: runtime imports are limited to @sangfor/shared (atomic write +
 * directory lock); @sangfor/spec is used for types only.
 */
export { canonicalEquals, canonicalJson } from './canonical.js';
export {
  buildEngineerReport,
  ENGINEER_REPORT_SCHEMA_VERSION,
  type EngineerReport,
  type EngineerReportInput,
  type EngineerReportRecord,
  type RagCitation,
  type ReadonlyEvaluationResult,
} from './report.js';
export {
  appendEngineerReport,
  canonicalReportPreimage,
  GENESIS,
  listEngineerReportRecords,
  listEngineerReports,
  verifyReportChain,
  type AppendEngineerReportResult,
  type VerifyReportChainResult,
} from './ledger.js';
export { validateEngineerReport, type ValidateEngineerReportResult } from './validate.js';
export { redactionToken, scrubPayload } from './scrub.js';
export {
  listGoldenFixtures,
  loadGoldenFixture,
  type GoldenFixture,
  type GoldenVendor,
} from './golden.js';
