/**
 * @sangfor/competency — Field-engineer WorkAtom taxonomy + honest replacement metric.
 *
 * Each WorkAtom is one unit of a field engineer's job, labelled auto/hybrid/human.
 * The replacement rate counts ONLY atoms that are automatable AND field_verified
 * AND grounded in a registered tool plus a confined evidence artifact — "an MCP
 * tool exists" never counts as replaced, a human-only atom never counts even if
 * mislabelled as covered, and an unverifiable claim refuses the whole report
 * rather than quietly shrinking the numerator. This keeps "1인 대체율" honest.
 */
export {
  LIFECYCLE_PHASES,
  AUTOMATABILITIES,
  MATURITIES,
  MATURITY_RANK,
  normalizeAtomId,
  capabilityKey,
  workAtomSchema,
  maturityPolicyEntrySchema,
  maturityPolicyFileSchema,
  type LifecyclePhase,
  type Automatability,
  type Maturity,
  type WorkAtom,
  type CapabilityRef,
  type MaturityPolicyEntry,
  type MaturityPolicyFile,
} from './schema.js';

export {
  COVERAGE_VIOLATION_KINDS,
  CoverageContextError,
  type CoverageViolation,
  type CoverageViolationKind,
} from './violations.js';

export { buildCoverageContext, type CoverageContext, type CoverageContextInput } from './context.js';
export { buildRepoCoverageContext, type RepoCoverageContextLoad } from './repo-context.js';
export { loadMaturityPolicyStrict, defaultPolicyRoot, type MaturityPolicyLoad } from './policy.js';
export {
  fetchBridgeToolRegistry,
  bridgeUrlFromEnv,
  DEFAULT_BRIDGE_URL,
  type ToolRegistryLoad,
  type ToolRegistrySource,
} from './tool-registry.js';
export { loadWorkAtomCatalog, defaultCatalogRoot, type CatalogLoad } from './loader.js';
export {
  computeReplacementCoverage,
  type CoverageBucket,
  type CoverageResult,
  type ReplacementReport,
} from './coverage.js';

export {
  CAPABILITY_EVIDENCE_VERSION,
  MAX_CAPABILITY_EVIDENCE_BYTES,
  MAX_EVIDENCE_RUNS,
  MAX_EVIDENCE_ARTIFACTS,
  MAX_NEGATIVE_CASES,
  O5_COUNTER_KEYS,
  EVIDENCE_RESULTS,
  firmwareTruthEvidenceSchema,
  capabilityEvidenceArtifactSchema,
  negativeCaseSchema,
  independentReadBackSchema,
  capabilityEvidenceRunSchema,
  o5CampaignCountersSchema,
  capabilityEvidenceManifestSchema,
  type CapabilityEvidenceArtifact,
  type CapabilityEvidenceRun,
  type CapabilityEvidenceManifest,
  type NegativeCase,
  type O5CampaignCounters,
} from './evidence-schema.js';

export {
  CAPABILITY_PROMOTION_VERSION,
  capabilityPromotionRequestSchema,
  capabilityPromotionDecisionSchema,
  capabilityPromotionEnvelopeSchema,
  type CapabilityPromotionRequest,
  type CapabilityPromotionDecision,
  type CapabilityPromotionEnvelope,
} from './promotion-schema.js';

export {
  parseGroundedCapabilityEvidence,
  parseGroundedCapabilityPromotion,
  CapabilityEvidenceGroundingError,
  type CapabilityEvidenceGrounding,
  type CapabilityEvidenceGroundingIssue,
} from './evidence-grounding.js';

export {
  MAX_TARGET_WORK_ATOMS,
  sha256Schema,
  evidenceIdSchema,
  firmwareValueSchema,
  timestampSchema,
  relativeArtifactPathSchema,
  mediaTypeSchema,
  actorIdentitySchema,
  capabilityTargetSchema,
  type ActorIdentity,
  type CapabilityTarget,
} from './evidence-primitives.js';
