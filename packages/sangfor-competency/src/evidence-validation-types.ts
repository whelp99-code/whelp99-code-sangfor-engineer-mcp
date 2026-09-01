import type { CapabilityEvidenceManifest } from './evidence-schema.js';

export const EVIDENCE_CAMPAIGNS = ['api_read_only', 'browser', 'mutation', 'mock_mutation'] as const;
export const MAX_EVIDENCE_ARTIFACT_BYTES = 67_108_864 as const;
export type EvidenceCampaign = (typeof EVIDENCE_CAMPAIGNS)[number];

export const REQUIRED_MUTATION_NEGATIVE_CASE_CODES = [
  'no_op',
  'ambiguity',
  'read_back_failure',
  'disconnect',
  'replay',
] as const;

export type EvidenceValidationIssueCode =
  | 'evidence_root_unreadable' | 'evidence_root_symlink' | 'evidence_root_not_directory'
  | 'artifact_unreadable' | 'artifact_outside_root' | 'artifact_symlink' | 'artifact_not_regular_file' | 'artifact_too_large'
  | 'artifact_size_mismatch' | 'artifact_digest_mismatch' | 'artifact_media_type_mismatch'
  | 'firmware_evidence_digest_mismatch' | 'identity_drift' | 'campaign_identity_mismatch'
  | 'future_evidence' | 'evidence_expired' | 'validation_context_mismatch'
  | 'identity_role_conflict' | 'identity_digest_collision'
  | 'insufficient_real_runs' | 'insufficient_device_diversity' | 'insufficient_window_diversity'
  | 'required_negative_case_missing' | 'incomplete_mutation_cycle'
  | 'independent_readback_incomplete' | 'restore_or_retain_incomplete'
  | 'retry_detected' | 'collateral_mutation_detected';

export type EvidenceValidationIssue = {
  readonly code: EvidenceValidationIssueCode;
  readonly path: readonly (string | number)[];
};

export type EvidenceValidationResult =
  | { readonly status: 'active'; readonly issues: readonly [] }
  | { readonly status: 'stale'; readonly issues: readonly EvidenceValidationIssue[] }
  | { readonly status: 'refused'; readonly issues: readonly EvidenceValidationIssue[] };

export type EvidenceFileStat = {
  readonly size: number;
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
};

export interface EvidenceFilesystem {
  realpath(path: string): string;
  lstat(path: string): EvidenceFileStat;
  readFile(path: string): Uint8Array;
}

export interface EvidenceClock {
  now(): Date;
}

export type EvidenceValidationRunIdentity = {
  readonly runId: string;
  readonly environment: 'real_device' | 'mock';
  readonly deviceIdentityDigest: string;
  readonly windowIdentityDigest: string;
};

type FirmwareTruth = CapabilityEvidenceManifest['firmwareTruth'];
type Digests = CapabilityEvidenceManifest['digests'];

export type CurrentFirmwareIdentity = Pick<FirmwareTruth,
  | 'vendor' | 'adapterProduct' | 'productVariant' | 'versionRaw' | 'versionFamily'
  | 'revision' | 'buildId' | 'hotfix' | 'uiFingerprint' | 'apiFingerprint'
  | 'specVersion' | 'truthDigest'>;

export type CurrentEvidenceDigests = Pick<Digests,
  'recipeDigest' | 'toolDigest' | 'runtimeDigest' | 'deviceIdentityDigest' | 'originDigest' | 'windowIdentityDigest'>;

export type EvidenceValidationContext = {
  readonly campaign: EvidenceCampaign;
  readonly targetEnvironment?: 'lab' | 'production';
  readonly clock: EvidenceClock;
  readonly currentFirmware: CurrentFirmwareIdentity;
  readonly currentDigests: CurrentEvidenceDigests;
  readonly reviewerActorId: string;
  readonly runIdentities: readonly EvidenceValidationRunIdentity[];
};

export type ValidateCapabilityEvidenceInput = {
  readonly manifest: CapabilityEvidenceManifest;
  readonly evidenceRoot: string;
  readonly filesystem: EvidenceFilesystem;
  readonly context: EvidenceValidationContext;
};
