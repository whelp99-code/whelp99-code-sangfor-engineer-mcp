import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capabilityEvidenceManifestSchema,
  nodeEvidenceFilesystem,
  relativeArtifactPathSchema,
  validateCapabilityEvidence,
  type CapabilityEvidenceManifest,
  type EvidenceValidationContext,
  type EvidenceValidationResult,
} from '../packages/sangfor-competency/src/index.js';
import {
  writeRetainedMutationFixture,
  writeValidationFixture,
} from './helpers/capability-evidence-validation-fixture.js';

const filesystem = nodeEvidenceFilesystem();
type RetentionVariant = 'valid' | 'wrong_kind' | 'wrong_media' | 'shared' | 'early' | 'late' | 'role_mismatch';

type RetainedFixture = {
  readonly rawManifest: unknown;
  readonly context: EvidenceValidationContext;
  readonly approvalPaths: readonly string[];
};

function writeRetainedFixture(root: string, variant: RetentionVariant = 'valid'): RetainedFixture {
  const base = writeRetainedMutationFixture(root);
  const retentionArtifacts = base.manifest.artifacts.filter(({ kind }) => kind === 'retention_approval');
  const retentionIds = new Set(retentionArtifacts.map(({ id }) => id));
  if (variant === 'valid') return { rawManifest: base.manifest, context: base.context, approvalPaths: base.approvalPaths };
  const firstApproval = retentionArtifacts[0];
  if (firstApproval === undefined) throw new Error('retention fixture missing');
  const artifacts = base.manifest.artifacts
    .filter((artifact) => variant !== 'shared' || artifact.kind !== 'retention_approval' || artifact.id === firstApproval.id)
    .map((artifact) => {
      if (artifact.kind !== 'retention_approval') return artifact;
      const run = base.manifest.runs.find(({ artifactIds }) => artifactIds.includes(artifact.id));
      if (run === undefined) throw new Error('retention owner missing');
      if (variant === 'wrong_kind') return { ...artifact, kind: 'audit' };
      if (variant === 'wrong_media') return { ...artifact, mediaType: 'text/plain' };
      if (variant === 'early') return { ...artifact, createdAt: new Date(Date.parse(run.independentReadBack.observedAt) - 1).toISOString() };
      if (variant === 'late') return { ...artifact, createdAt: '2026-08-25T12:00:00.001Z' };
      return artifact;
    });
  const secondApprovalPath = base.approvalPaths[1];
  if (secondApprovalPath === undefined) throw new Error('second retention fixture missing');
  const runs = base.manifest.runs.map((run, index) => {
    if (variant === 'shared') {
      return {
        ...run,
        postRunState: { mode: 'retained', result: 'pass', approvalAuditRef: firstApproval.path },
        artifactIds: [...run.artifactIds.filter((id) => !retentionIds.has(id)), firstApproval.id],
      };
    }
    if (variant === 'role_mismatch' && index === 0) {
      return { ...run, postRunState: { ...run.postRunState, approvalAuditRef: secondApprovalPath } };
    }
    return run;
  });
  return { rawManifest: { ...base.manifest, runs, artifacts }, context: base.context, approvalPaths: base.approvalPaths };
}

function validateBoundary(rawManifest: unknown, root: string, context: EvidenceValidationContext): EvidenceValidationResult {
  const parsed = capabilityEvidenceManifestSchema.safeParse(rawManifest);
  if (!parsed.success) return { status: 'refused', issues: [{ code: 'restore_or_retain_incomplete', path: ['runs'] }] };
  return validateCapabilityEvidence({ manifest: parsed.data, evidenceRoot: root, filesystem, context });
}

function parseValid(rawManifest: unknown): CapabilityEvidenceManifest {
  return capabilityEvidenceManifestSchema.parse(rawManifest);
}

describe('retained mutation approval evidence', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capability-retention-'));
    outside = mkdtempSync(join(tmpdir(), 'capability-retention-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses the verifier reproduction of three retained cycles with nonexistent approval refs', () => {
    // Given
    const fixture = writeRetainedMutationFixture(root);
    const manifest = {
      ...fixture.manifest,
      runs: fixture.manifest.runs.map((run, index) => ({
        ...run,
        postRunState: {
          mode: 'retained' as const,
          result: 'pass' as const,
          approvalAuditRef: relativeArtifactPathSchema.parse(`retention/missing-${index + 1}.json`),
        },
      })),
    };

    // When
    const result = validateCapabilityEvidence({ manifest, evidenceRoot: root, filesystem, context: fixture.context });

    // Then
    expect(result.status).toBe('refused');
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['incomplete_mutation_cycle', 'restore_or_retain_incomplete']));
  });

  it('activates three retained cycles with dedicated approval artifacts', () => {
    // Given
    const fixture = writeRetainedFixture(root);
    const manifest = parseValid(fixture.rawManifest);

    // When
    const result = validateCapabilityEvidence({ manifest, evidenceRoot: root, filesystem, context: fixture.context });

    // Then
    expect(result).toEqual({ status: 'active', issues: [] });
  });

  it('keeps three restored mutation cycles active', () => {
    // Given
    const fixture = writeValidationFixture(root, 'mutation');

    // When
    const result = validateCapabilityEvidence({ manifest: fixture.manifest, evidenceRoot: root, filesystem, context: fixture.context });

    // Then
    expect(result.status).toBe('active');
  });

  it.each(['wrong_kind', 'wrong_media', 'shared', 'early', 'late', 'role_mismatch'] as const)(
    'refuses retained approval evidence with %s declarations',
    (variant) => {
      // Given
      const fixture = writeRetainedFixture(root, variant);

      // When
      const result = validateBoundary(fixture.rawManifest, root, fixture.context);

      // Then
      expect(result.status).toBe('refused');
    },
  );

  it.each([
    ['outside symlink', 'artifact_symlink', (path: string) => { writeFileSync(join(outside, 'approval.json'), '{}'); rmSync(path); symlinkSync(join(outside, 'approval.json'), path); }],
    ['inside symlink', 'artifact_symlink', (path: string) => { writeFileSync(join(root, 'inside.json'), '{}'); rmSync(path); symlinkSync(join(root, 'inside.json'), path); }],
    ['directory', 'artifact_not_regular_file', (path: string) => { rmSync(path); mkdirSync(path); }],
    ['hash and size drift', 'artifact_size_mismatch', (path: string) => { writeFileSync(path, '{"drift":true}'); }],
  ])('refuses a retained approval artifact that becomes a %s', (_name, expectedCode, mutate) => {
    // Given
    const fixture = writeRetainedFixture(root);
    const manifest = parseValid(fixture.rawManifest);
    const approvalPath = fixture.approvalPaths[0];
    if (approvalPath === undefined) throw new Error('approval fixture missing');
    mutate(join(root, approvalPath));

    // When
    const result = validateCapabilityEvidence({ manifest, evidenceRoot: root, filesystem, context: fixture.context });

    // Then
    expect(result.status).toBe('refused');
    expect(result.issues.map(({ code }) => code)).toContain(expectedCode);
  });
});
