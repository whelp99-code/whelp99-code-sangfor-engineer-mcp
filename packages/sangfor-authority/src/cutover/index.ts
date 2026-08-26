export { resolveCutoverAdapter, type AdapterRegistryOptions, type ResolvedCutoverAdapter } from './adapter-registry.js';
export {
  AUTHORITY_ADAPTER_POLICIES,
  parseAuthorityAdapterRegistry,
  type AuthorityAdapterPolicy,
} from './adapter-policy.js';
export { AuthorityCutoverError } from './errors.js';
export { FilesystemCutoverSourceAdapter, type FilesystemSourceOptions } from './filesystem-source.js';
export { AuditCutoverTarget, EvidenceCutoverTarget, RegistryCutoverTarget, RunsCutoverTarget } from './core-aggregate-targets.js';
export {
  CapabilityCutoverTarget, ChronicleCutoverTarget, EvalCutoverTarget, FeedbackCutoverTarget,
  LearningCutoverTarget, PmTaskCutoverTarget, WikiCutoverTarget,
} from './domain-targets.js';
export { type TargetScope } from './postgres-target-base.js';
export { InvalidateOnCutoverAdapter, PostgresNativeAdapter } from './policy-adapters.js';
export { AuthorityCutoverMachine } from './machine.js';
export { PostgresCutoverRepository } from './postgres-repository.js';
export { PostgresAuthorityWriteFence, type PostgresWriteFenceFaults } from './write-fence.js';
export {
  ABSENT_DIGEST, PostgresLocalWriteIntentRepository, captureTargetDigests, digestTargetDigestMap,
  type LocalWriteIntentRow,
} from './write-intents.js';
export { removeLocalSafetyMarker, writeLocalSafetyMarker, type LocalSafetyMarkerScope } from './safety-marker.js';
export { canonicalRecordSet, parseCutoverRecord } from './records.js';
export { transitionCutover } from './transition.js';
export { LOCAL_WRITER_REFS, verifyLocalWriterCoverage } from './writer-coverage.js';
export { CutoverState } from './types.js';
export type {
  CutoverAggregateState,
  CutoverCommand,
  CutoverRecord,
  CutoverScope,
  CutoverSourceAdapter,
  CutoverTargetAdapter,
} from './types.js';
