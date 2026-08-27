/**
 * JM agent runtime edge — VERIFY ONLY.
 *
 * This package deliberately exports no signer, no private-key API, and no mock
 * execution port. JM can verify what BLRO signed and refuse; it can never mint
 * authority, and production can never quietly run without a browser.
 */
export {
  AUTHORITY_RECEIPT_REFUSALS,
  AUTHORITY_RECEIPT_VERSION,
  authorityReceiptSchema,
  verifyAuthorityReceipt,
} from './authority-receipt.js';
export type {
  AuthorityReceipt,
  AuthorityReceiptDecision,
  AuthorityReceiptExpectation,
  AuthorityReceiptRefusal,
  VerifyAuthorityReceiptInput,
} from './authority-receipt.js';
export {
  GRANT_SNAPSHOT_REFUSALS,
  GRANT_SNAPSHOT_VERSION,
  grantSnapshotSchema,
  verifyGrantSnapshot,
} from './grant-snapshot.js';
export type {
  GrantSnapshot,
  GrantSnapshotDecision,
  GrantSnapshotRefusal,
  GrantSnapshotScope,
} from './grant-snapshot.js';
export {
  JM_AGENT_CONFIG_FIELDS,
  JM_AGENT_ENVIRONMENT_NAMES,
  JM_AGENT_FORBIDDEN_FIELDS,
  jmAgentConfigSchema,
} from './config-schema.js';
export type {
  JmAgentConfig,
  JmAgentConfigField,
  JmAgentEnvironment,
} from './config-schema.js';
export { parseJmAgentConfig } from './config.js';
export type {
  JmAgentConfigIssue,
  JmAgentConfigIssueCode,
  JmAgentConfigResult,
} from './config.js';
export {
  MATERIAL_REFUSALS,
  checkMaterialPath,
} from './material.js';
export type { MaterialCheck, MaterialRefusal } from './material.js';
export {
  CERT_SIGN_KEY_USAGE,
  SERVER_AUTH_EKU,
  SERVER_IDENTITY_REFUSALS,
  canonicalizeAllowedOrigin,
  checkServerIdentity,
  parseBlroSanUri,
} from './server-identity.js';
export type { ServerIdentityCheck, ServerIdentityRefusal } from './server-identity.js';
export {
  KEY_RING_REFUSALS,
  KEY_RING_VERSION,
  KeyRing,
  MAX_OVERLAP_KEYS,
  keyRingSchema,
  publicKeyDigest,
} from './key-ring.js';
export type { KeyRingDocument, KeyRingEntry, KeyRingRefusal } from './key-ring.js';
export {
  JOURNAL_HEADER_KIND,
  JOURNAL_REFUSALS,
  REFUSAL_JOURNAL_VERSION,
  RefusalJournal,
  RefusalJournalError,
  appendDurably,
  assertSecureFile,
  createJournalExclusively,
  assertSecureRoot,
  journalHeaderLine,
} from './refusal-journal.js';
export type {
  JournalHeader,
  JournalRefusal,
  JournalReservation,
  JournalReservationInput,
  RefusalJournalEntry,
} from './refusal-journal.js';
export {
  RECEIPT_HEADER,
  RECEIPT_ID_HEADER,
  REMOTE_BROWSER_EXECUTION_SCOPE,
  createReceiptRemoteJobStore,
} from './receipt-job-store.js';
export type { ReceiptRemoteJobStoreOptions } from './receipt-job-store.js';
export { createBlroClientAuthorizer } from './client-pin.js';
export type { BlroClientPin } from './client-pin.js';
export { DrainTimeoutError, InFlightJobs } from './in-flight.js';
export { ActiveExecutions, DrainCoordinator } from './drain.js';
export type { DrainDependencies, DrainOutcome } from './drain.js';
export { EXECUTION_PREFLIGHT_REFUSALS, toBrowserExecutionPort } from './execution-port.js';
export type {
  ExecutionPreflight,
  ExecutionPreflightRefusal,
  JmExecutionPort,
  JmExecutionPortFactory,
} from './execution-port.js';
export {
  JM_READINESS_REASONS,
  firstReadinessFailure,
  livenessFrom,
  readinessFrom,
} from './readiness.js';
export type {
  JmLiveness,
  JmLivenessState,
  JmReadiness,
  JmReadinessCheck,
  JmReadinessChecks,
  JmReadinessReason,
} from './readiness.js';
export { JOURNAL_FILE_NAME, JmRuntimeStartupError, createJmAgentRuntime } from './runtime.js';
export type { JmAgentRuntime, JmAgentRuntimeInput } from './runtime.js';
