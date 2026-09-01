import type { CapabilityEvidenceManifest } from './evidence-schema.js';
import {
  REQUIRED_MUTATION_NEGATIVE_CASE_CODES,
  type CurrentFirmwareIdentity,
  type EvidenceValidationContext,
  type EvidenceValidationIssue,
  type EvidenceValidationIssueCode,
} from './evidence-validation-types.js';

const ADVISORY_NEGATIVE_CASE_CODES = ['missing_observation', 'ambiguous_observation'] as const;
const FIRMWARE_KEYS = [
  'vendor', 'adapterProduct', 'productVariant', 'versionRaw', 'versionFamily', 'revision', 'buildId',
  'hotfix', 'uiFingerprint', 'apiFingerprint', 'specVersion', 'truthDigest',
] as const satisfies readonly (keyof CurrentFirmwareIdentity)[];

const validationIssue = (code: EvidenceValidationIssueCode, path: readonly (string | number)[]): EvidenceValidationIssue => ({ code, path });

export function validateCurrentIdentity(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  if (FIRMWARE_KEYS.some((key) => manifest.firmwareTruth[key] !== context.currentFirmware[key])) {
    issues.push(validationIssue('identity_drift', ['firmwareTruth']));
  }
  const driftDigests = ['recipeDigest', 'toolDigest', 'runtimeDigest'] as const;
  driftDigests.forEach((key) => {
    if (manifest.digests[key] !== context.currentDigests[key]) issues.push(validationIssue('identity_drift', ['digests', key]));
  });
  const campaignDigests = ['deviceIdentityDigest', 'originDigest', 'windowIdentityDigest'] as const;
  campaignDigests.forEach((key) => {
    if (manifest.digests[key] !== context.currentDigests[key]) issues.push(validationIssue('campaign_identity_mismatch', ['digests', key]));
  });
  return issues;
}

function validateContextCoverage(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const runIds = new Set<string>(manifest.runs.map(({ id }) => id));
  const contextIds = new Set<string>(context.runIdentities.map(({ runId }) => runId));
  if (contextIds.size !== context.runIdentities.length || runIds.size !== contextIds.size
    || [...runIds].some((runId) => !contextIds.has(runId))) {
    issues.push(validationIssue('validation_context_mismatch', ['runIdentities']));
  }
  const digestPattern = /^[a-f0-9]{64}$/u;
  if (context.runIdentities.some(({ deviceIdentityDigest, windowIdentityDigest }) =>
    !digestPattern.test(deviceIdentityDigest) || !digestPattern.test(windowIdentityDigest))) {
    issues.push(validationIssue('validation_context_mismatch', ['runIdentities']));
  }
  const deviceDigests = new Set(context.runIdentities.map(({ deviceIdentityDigest }) => deviceIdentityDigest));
  if (context.runIdentities.some(({ windowIdentityDigest }) => deviceDigests.has(windowIdentityDigest))) {
    issues.push(validationIssue('identity_digest_collision', ['runIdentities']));
  }
  return issues;
}

function validateRoles(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
): readonly EvidenceValidationIssue[] {
  const executorIds = new Set<string>(manifest.runs.map(({ executor }) => executor.actorId));
  const readerIds = new Set<string>(manifest.runs.map(({ independentReadBack }) => independentReadBack.verifier.actorId));
  if (executorIds.has(context.reviewerActorId) || readerIds.has(context.reviewerActorId)
    || [...executorIds].some((actorId) => readerIds.has(actorId))) {
    return [validationIssue('identity_role_conflict', ['reviewerActorId'])];
  }
  return [];
}

function validateAdvisoryThresholds(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const realRunIds = new Set<string>(context.runIdentities
    .filter(({ environment }) => environment === 'real_device')
    .map(({ runId }) => runId));
  const passRuns = manifest.runs.filter(({ id, result }) => result === 'pass' && realRunIds.has(id));
  const passIds = new Set<string>(passRuns.map(({ id }) => id));
  const devices = new Set(context.runIdentities
    .filter(({ runId }) => passIds.has(runId))
    .map(({ deviceIdentityDigest }) => deviceIdentityDigest));
  if (passRuns.length < 5) issues.push(validationIssue('insufficient_real_runs', ['runs']));
  if (devices.size < 2) issues.push(validationIssue('insufficient_device_diversity', ['runIdentities']));
  if (!manifest.negativeCases.some(({ caseCode, result }) =>
    result === 'indeterminate' && ADVISORY_NEGATIVE_CASE_CODES.some((required) => required === caseCode))) {
    issues.push(validationIssue('required_negative_case_missing', ['negativeCases']));
  }
  return issues;
}

type MutationThresholds = {
  readonly environment: 'real_device' | 'mock';
  readonly minimumRuns: number;
  readonly minimumDevices: number;
  readonly minimumWindows: number;
};

function validateMutationThresholds(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
  thresholds: MutationThresholds,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const eligibleIds = new Set<string>(context.runIdentities
    .filter(({ environment }) => environment === thresholds.environment)
    .map(({ runId }) => runId));
  const artifactsById = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const artifactOwners = new Map<string, number>();
  manifest.runs.forEach((run) => {
    new Set(run.artifactIds).forEach((id) => artifactOwners.set(id, (artifactOwners.get(id) ?? 0) + 1));
  });
  const postRunEvidenceIsComplete = (run: CapabilityEvidenceManifest['runs'][number]): boolean => {
    switch (run.postRunState.mode) {
      case 'restored': {
        const artifact = artifactsById.get(run.postRunState.readBackArtifactId);
        return artifact?.kind === 'restore' && run.artifactIds.includes(artifact.id) && artifactOwners.get(artifact.id) === 1;
      }
      case 'retained': {
        const approvalAuditRef = run.postRunState.approvalAuditRef;
        const approvals = manifest.artifacts.filter(({ path }) => path === approvalAuditRef);
        const approval = approvals.length === 1 ? approvals[0] : undefined;
        return approval?.kind === 'retention_approval' && approval.mediaType === 'application/json'
          && run.artifactIds.includes(approval.id) && artifactOwners.get(approval.id) === 1
          && Date.parse(approval.createdAt) > Date.parse(run.independentReadBack.observedAt)
          && Date.parse(approval.createdAt) <= Date.parse(manifest.generatedAt);
      }
      default:
        run.postRunState satisfies never;
        return false;
    }
  };
  const mutationRuns = manifest.runs.filter(({ mutationAttempted }) => mutationAttempted);
  const complete = mutationRuns.filter((run) => eligibleIds.has(run.id) && run.result === 'pass' && run.mutationCount === 1
    && run.independentReadBack.result === 'pass' && run.postRunState.result === 'pass' && postRunEvidenceIsComplete(run));
  const completeIds = new Set<string>(complete.map(({ id }) => id));
  const identities = context.runIdentities.filter(({ runId }) => completeIds.has(runId));
  if (complete.length < thresholds.minimumRuns) issues.push(validationIssue('incomplete_mutation_cycle', ['runs']));
  if (new Set(identities.map(({ deviceIdentityDigest }) => deviceIdentityDigest)).size < thresholds.minimumDevices) {
    issues.push(validationIssue('insufficient_device_diversity', ['runIdentities']));
  }
  if (new Set(identities.map(({ windowIdentityDigest }) => windowIdentityDigest)).size < thresholds.minimumWindows) {
    issues.push(validationIssue('insufficient_window_diversity', ['runIdentities']));
  }
  if (mutationRuns.some(({ independentReadBack }) => independentReadBack.result !== 'pass')) {
    issues.push(validationIssue('independent_readback_incomplete', ['runs']));
  }
  if (mutationRuns.some((run) => run.postRunState.result !== 'pass' || !postRunEvidenceIsComplete(run))) {
    issues.push(validationIssue('restore_or_retain_incomplete', ['runs']));
  }
  if (mutationRuns.some(({ retryCount }) => retryCount !== 0)) issues.push(validationIssue('retry_detected', ['runs']));
  if (mutationRuns.some(({ collateralMutationCount }) => collateralMutationCount !== 0)) {
    issues.push(validationIssue('collateral_mutation_detected', ['runs']));
  }
  const passingCodes = new Set<string>(manifest.negativeCases.filter(({ result }) => result === 'pass').map(({ caseCode }) => caseCode));
  if (REQUIRED_MUTATION_NEGATIVE_CASE_CODES.some((caseCode) => !passingCodes.has(caseCode))) {
    issues.push(validationIssue('required_negative_case_missing', ['negativeCases']));
  }
  return issues;
}

export function validateEvidencePolicy(
  manifest: CapabilityEvidenceManifest,
  context: EvidenceValidationContext,
): readonly EvidenceValidationIssue[] {
  const commonIssues = [
    ...validateContextCoverage(manifest, context),
    ...validateRoles(manifest, context),
  ];
  switch (context.campaign) {
    case 'api_read_only':
    case 'browser':
      return [...commonIssues, ...validateAdvisoryThresholds(manifest, context)];
    case 'mutation':
      return [...commonIssues, ...validateMutationThresholds(manifest, context, {
        environment: 'real_device', minimumRuns: 3, minimumDevices: 2, minimumWindows: 2,
      })];
    case 'mock_mutation':
      return [...commonIssues, ...validateMutationThresholds(manifest, context, {
        environment: 'mock', minimumRuns: 3, minimumDevices: 2, minimumWindows: 2,
      })];
    default:
      context.campaign satisfies never;
      return commonIssues;
  }
}
