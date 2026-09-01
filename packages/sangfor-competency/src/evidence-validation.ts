import {
  resolveEvidenceFile,
  resolveEvidenceRoot,
  sha256,
  verifyArtifactFile,
} from './evidence-filesystem.js';
import { validateCurrentIdentity, validateEvidencePolicy } from './evidence-policy-validation.js';
import type {
  EvidenceValidationIssue,
  EvidenceValidationResult,
  ValidateCapabilityEvidenceInput,
} from './evidence-validation-types.js';

const DAY_MILLISECONDS = 86_400_000;
const STALE_CODES = new Set(['evidence_expired', 'identity_drift']);

function validateFiles(input: ValidateCapabilityEvidenceInput, root: string): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  input.manifest.artifacts.forEach((artifact, index) => {
    const file = resolveEvidenceFile({
      filesystem: input.filesystem,
      root,
      claimedPath: artifact.path,
      issuePath: ['artifacts', index, 'path'],
    });
    if (!file.ok) {
      issues.push(file.issue);
      return;
    }
    issues.push(...verifyArtifactFile(artifact, index, file));
  });
  const firmwareFile = resolveEvidenceFile({
    filesystem: input.filesystem,
    root,
    claimedPath: input.manifest.firmwareTruth.evidenceFile,
    issuePath: ['firmwareTruth', 'evidenceFile'],
  });
  if (!firmwareFile.ok) issues.push(firmwareFile.issue);
  else if (sha256(firmwareFile.bytes) !== input.manifest.firmwareTruth.truthDigest) {
    issues.push({ code: 'firmware_evidence_digest_mismatch', path: ['firmwareTruth', 'truthDigest'] });
  }
  return issues;
}

function validateFreshness(input: ValidateCapabilityEvidenceInput): readonly EvidenceValidationIssue[] {
  const now = input.context.clock.now().getTime();
  const generatedAt = Date.parse(input.manifest.generatedAt);
  if (!Number.isFinite(now)) return [{ code: 'validation_context_mismatch', path: ['clock'] }];
  if (generatedAt > now) return [{ code: 'future_evidence', path: ['generatedAt'] }];
  let maximumAgeDays: 90 | 180;
  switch (input.context.campaign) {
    case 'api_read_only':
      maximumAgeDays = 180;
      break;
    case 'browser':
    case 'mutation':
    case 'mock_mutation':
      maximumAgeDays = 90;
      break;
    default:
      input.context.campaign satisfies never;
      return [{ code: 'validation_context_mismatch', path: ['campaign'] }];
  }
  return now - generatedAt > maximumAgeDays * DAY_MILLISECONDS
    ? [{ code: 'evidence_expired', path: ['generatedAt'] }]
    : [];
}

export function validateCapabilityEvidence(input: ValidateCapabilityEvidenceInput): EvidenceValidationResult {
  const root = resolveEvidenceRoot(input.filesystem, input.evidenceRoot);
  if (!root.ok) return { status: 'refused', issues: [root.issue] };
  const issues = [
    ...validateFiles(input, root.root),
    ...validateCurrentIdentity(input.manifest, input.context),
    ...validateEvidencePolicy(input.manifest, input.context),
    ...validateFreshness(input),
  ];
  if (issues.length === 0) return { status: 'active', issues: [] };
  return issues.every(({ code }) => STALE_CODES.has(code))
    ? { status: 'stale', issues }
    : { status: 'refused', issues };
}

export type {
  CurrentEvidenceDigests,
  CurrentFirmwareIdentity,
  EvidenceCampaign,
  EvidenceClock,
  EvidenceFilesystem,
  EvidenceValidationContext,
  EvidenceValidationIssue,
  EvidenceValidationIssueCode,
  EvidenceValidationResult,
  EvidenceValidationRunIdentity,
  ValidateCapabilityEvidenceInput,
} from './evidence-validation-types.js';
export { EVIDENCE_CAMPAIGNS, MAX_EVIDENCE_ARTIFACT_BYTES, REQUIRED_MUTATION_NEGATIVE_CASE_CODES } from './evidence-validation-types.js';
export { nodeEvidenceFilesystem } from './evidence-filesystem.js';
export { evidenceValidationContextSchema, parseEvidenceValidationContext } from './evidence-validation-context.js';
