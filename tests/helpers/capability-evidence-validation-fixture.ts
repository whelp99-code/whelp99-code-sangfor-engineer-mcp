import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestCanonicalOrigin } from '../../packages/shared/src/index.js';
import {
  capabilityEvidenceManifestSchema,
  type CapabilityEvidenceManifest,
  type EvidenceValidationContext,
  type EvidenceValidationRunIdentity,
} from '../../packages/sangfor-competency/src/index.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const actor = (actorId: string, actorType: 'ai_engineer' | 'service' = 'ai_engineer') => ({ actorId, actorType });

export type ValidationFixture = {
  readonly manifest: CapabilityEvidenceManifest;
  readonly context: EvidenceValidationContext;
};

export type RetainedValidationFixture = ValidationFixture & {
  readonly approvalPaths: readonly string[];
};

export function writeValidationFixture(root: string, campaign: 'api_read_only' | 'browser' | 'mutation' = 'api_read_only'): ValidationFixture {
  const generatedAt = '2026-08-25T12:00:00.000Z';
  const runCount = campaign === 'mutation' ? 3 : 5;
  const artifacts: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const runIdentities: EvidenceValidationRunIdentity[] = [];
  let mutationCount = 0;
  let restoredCount = 0;
  for (let index = 0; index < runCount; index += 1) {
    const runId = `run-${index + 1}`;
    const startedAt = `2026-08-2${index + 1}T10:00:00.000Z`;
    const completedAt = `2026-08-2${index + 1}T10:01:00.000Z`;
    const observedAt = `2026-08-2${index + 1}T10:02:00.000Z`;
    const runArtifactId = `artifact-run-${index + 1}`;
    const readbackArtifactId = `artifact-readback-${index + 1}`;
    const restoreArtifactId = `artifact-restore-${index + 1}`;
    const runPath = `runs/${runId}.json`;
    const readbackPath = `readback/${runId}.json`;
    const restorePath = `restore/${runId}.json`;
    const artifactIds = [runArtifactId, readbackArtifactId];
    const addArtifact = (artifact: {
      readonly id: string;
      readonly kind: 'run' | 'readback' | 'restore';
      readonly path: string;
      readonly body: string;
      readonly createdAt: string;
    }): void => {
      mkdirSync(join(root, artifact.path, '..'), { recursive: true });
      writeFileSync(join(root, artifact.path), artifact.body);
      const { body, ...declaration } = artifact;
      artifacts.push({ ...declaration, fileType: 'regular_file', sha256: hash(body), sizeBytes: Buffer.byteLength(body), mediaType: 'application/json' });
    };
    addArtifact({ id: runArtifactId, kind: 'run', path: runPath, body: JSON.stringify({ runId }), createdAt: completedAt });
    addArtifact({ id: readbackArtifactId, kind: 'readback', path: readbackPath, body: JSON.stringify({ runId, readBack: true }), createdAt: observedAt });
    let postRunState: Record<string, unknown> = { mode: 'retained', result: 'pass', approvalAuditRef: `audit/${runId}.json` };
    if (campaign === 'mutation') {
      addArtifact({ id: restoreArtifactId, kind: 'restore', path: restorePath, body: JSON.stringify({ runId, restored: true }), createdAt: observedAt });
      artifactIds.push(restoreArtifactId);
      postRunState = { mode: 'restored', result: 'pass', readBackArtifactId: restoreArtifactId };
      mutationCount += 1;
      restoredCount += 1;
    }
    runs.push({
      id: runId, result: 'pass', executor: actor(`executor-${index + 1}`), startedAt, completedAt,
      independentReadBack: {
        independent: true, verifier: actor(`verifier-${index + 1}`, 'service'), result: 'pass',
        observedStateDigest: hash(`state-${index}`), artifactId: readbackArtifactId, observedAt,
      },
      postRunState, mutationAttempted: campaign === 'mutation', mutationCount: campaign === 'mutation' ? 1 : 0,
      retryCount: 0, collateralMutationCount: 0, auditRef: `audit/${runId}.jsonl`,
      evidenceChainRef: `chains/${runId}.json`, artifactIds, negativeCaseIds: index === 0 ? ['negative-required'] : [],
    });
    runIdentities.push({
      runId,
      environment: 'real_device',
      deviceIdentityDigest: hash(`device-${index % 2}`),
      windowIdentityDigest: hash(`window-${campaign === 'mutation' ? index % 2 : 0}`),
    });
  }
  const requiredCodes = campaign === 'mutation'
    ? ['no_op', 'ambiguity', 'read_back_failure', 'disconnect', 'replay']
    : ['ambiguous_observation'];
  const negativeCases: Record<string, unknown>[] = [];
  requiredCodes.forEach((caseCode, index) => {
    const id = index === 0 ? 'negative-required' : `negative-${index + 1}`;
    const artifactId = `artifact-negative-${index + 1}`;
    const path = `negative/${caseCode}.json`;
    const body = JSON.stringify({ caseCode });
    mkdirSync(join(root, 'negative'), { recursive: true });
    writeFileSync(join(root, path), body);
    artifacts.push({ id: artifactId, kind: 'negative', path, fileType: 'regular_file', sha256: hash(body), sizeBytes: Buffer.byteLength(body), mediaType: 'application/json', createdAt: '2026-08-21T10:00:30.000Z' });
    negativeCases.push({
      id, caseCode, expectedRefusalCode: caseCode.toUpperCase(), observedRefusalCode: caseCode.toUpperCase(),
      result: campaign === 'mutation' ? 'pass' : 'indeterminate', artifactIds: [artifactId], testedAt: '2026-08-21T10:00:40.000Z',
    });
    if (index > 0) {
      const firstRun = runs[0];
      if (firstRun !== undefined && Array.isArray(firstRun['negativeCaseIds'])) firstRun['negativeCaseIds'].push(id);
    }
  });
  mkdirSync(join(root, 'firmware'), { recursive: true });
  const firmwareBody = JSON.stringify({ version: '6.10.0R2' });
  writeFileSync(join(root, 'firmware/truth-hci.json'), firmwareBody);
  const firmwareTruth = {
    recordId: 'firmware-hci-6.10.0', vendor: 'SANGFOR', adapterProduct: 'HCI_SCP', productVariant: 'SCP',
    versionRaw: '6.10.0R2', versionFamily: '6.10', revision: 'R2', buildId: null, hotfix: null,
    uiFingerprint: hash('ui'), apiFingerprint: hash('api'), status: 'verified', observedAt: '2026-08-20T10:00:00.000Z',
    evidenceFile: 'firmware/truth-hci.json', specVersion: '6.10', specApplicability: 'verified', truthDigest: hash(firmwareBody),
  };
  const digests = {
    recipeDigest: hash('recipe'), toolDigest: hash('tool'), runtimeDigest: hash('runtime'),
    deviceIdentityDigest: hash('campaign-devices'),
    originDigest: digestCanonicalOrigin('https://evidence.invalid', 'origin'),
    windowIdentityDigest: hash('campaign-windows'),
  };
  const manifest = capabilityEvidenceManifestSchema.parse({
    version: 1, manifestId: `manifest-${campaign}`, generatedAt,
    target: { productId: 'HCI_SCP', capabilityId: 'resource_inventory', toolId: 'sangfor_evaluate_config', workAtomIds: ['op_daily_health'] },
    firmwareTruth, digests, runs, artifacts, negativeCases,
    o5Counters: {
      runCount, passCount: runCount, failCount: 0, indeterminateCount: 0, independentReadBackPassCount: runCount,
      negativeCasePassCount: campaign === 'mutation' ? 5 : 0, restoredCount, retainedCount: runCount - restoredCount,
      mutationCount, retryCount: 0, collateralMutationCount: 0,
    },
  });
  const currentFirmware = {
    vendor: manifest.firmwareTruth.vendor,
    adapterProduct: manifest.firmwareTruth.adapterProduct,
    productVariant: manifest.firmwareTruth.productVariant,
    versionRaw: manifest.firmwareTruth.versionRaw,
    versionFamily: manifest.firmwareTruth.versionFamily,
    revision: manifest.firmwareTruth.revision,
    buildId: manifest.firmwareTruth.buildId,
    hotfix: manifest.firmwareTruth.hotfix,
    uiFingerprint: manifest.firmwareTruth.uiFingerprint,
    apiFingerprint: manifest.firmwareTruth.apiFingerprint,
    specVersion: manifest.firmwareTruth.specVersion,
    truthDigest: manifest.firmwareTruth.truthDigest,
  };
  return {
    manifest,
    context: {
      campaign,
      clock: { now: () => new Date('2026-08-25T12:00:00.000Z') },
      currentFirmware,
      currentDigests: manifest.digests,
      reviewerActorId: 'human-reviewer-1',
      runIdentities,
    },
  };
}

export function writeRetainedMutationFixture(root: string): RetainedValidationFixture {
  const base = writeValidationFixture(root, 'mutation');
  const restoreIds = new Set(base.manifest.artifacts.filter(({ kind }) => kind === 'restore').map(({ id }) => id));
  rmSync(join(root, 'restore'), { recursive: true, force: true });
  const approvalPaths: string[] = [];
  const approvalArtifacts: Record<string, unknown>[] = [];
  const runs = base.manifest.runs.map((run, index) => {
    const id = `artifact-retention-${index + 1}`;
    const path = `retention/${run.id}.json`;
    const body = JSON.stringify({ runId: run.id, approvedBy: 'human-reviewer-1' });
    const createdAt = new Date(Date.parse(run.independentReadBack.observedAt) + 1).toISOString();
    mkdirSync(join(root, 'retention'), { recursive: true });
    writeFileSync(join(root, path), body);
    approvalPaths.push(path);
    approvalArtifacts.push({
      id, kind: 'retention_approval', path, fileType: 'regular_file', sha256: hash(body),
      sizeBytes: Buffer.byteLength(body), mediaType: 'application/json', createdAt,
    });
    return {
      ...run,
      postRunState: { mode: 'retained', result: 'pass', approvalAuditRef: path },
      artifactIds: [...run.artifactIds.filter((artifactId) => !restoreIds.has(artifactId)), id],
    };
  });
  const manifest = capabilityEvidenceManifestSchema.parse({
    ...base.manifest,
    runs,
    artifacts: [...base.manifest.artifacts.filter(({ kind }) => kind !== 'restore'), ...approvalArtifacts],
    o5Counters: { ...base.manifest.o5Counters, restoredCount: 0, retainedCount: 3 },
  });
  return { manifest, context: base.context, approvalPaths };
}
