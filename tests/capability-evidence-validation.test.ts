import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_EVIDENCE_ARTIFACT_BYTES,
  capabilityEvidenceManifestSchema,
  firmwareValueSchema,
  nodeEvidenceFilesystem,
  parseEvidenceValidationContext,
  sha256Schema,
  validateCapabilityEvidence,
  type CapabilityEvidenceManifest,
  type EvidenceValidationContext,
} from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture, type ValidationFixture } from './helpers/capability-evidence-validation-fixture.js';

const filesystem = nodeEvidenceFilesystem();
const issueCodes = (result: ReturnType<typeof validateCapabilityEvidence>): readonly string[] => result.issues.map(({ code }) => code);
const parseManifest = (value: unknown): CapabilityEvidenceManifest => capabilityEvidenceManifestSchema.parse(value);

function validate(root: string, fixture: ValidationFixture, context: EvidenceValidationContext = fixture.context) {
  return validateCapabilityEvidence({ manifest: fixture.manifest, evidenceRoot: root, filesystem, context });
}

describe('capability evidence fail-closed validation', () => {
  let root: string;
  let outside: string;

  it('characterizes the committed advisory fixture as active through real files', () => {
    // Given
    const fixtureRoot = new URL('./fixtures/capability-evidence/evidence/', import.meta.url);
    const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(
      new URL('./fixtures/capability-evidence/active-advisory-manifest.json', import.meta.url),
      'utf8',
    )));
    const context = parseEvidenceValidationContext(JSON.parse(readFileSync(new URL('validation-context.json', fixtureRoot), 'utf8')));

    // When
    const result = validateCapabilityEvidence({ manifest, evidenceRoot: fixtureRoot.pathname, filesystem, context });

    // Then
    expect(result).toEqual({ status: 'active', issues: [] });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capability-evidence-validation-'));
    outside = mkdtempSync(join(tmpdir(), 'capability-evidence-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('returns active for exact advisory evidence at the 180-day boundary', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const context = { ...fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.000Z') } };

    // When
    const result = validate(root, fixture, context);

    // Then
    expect(result).toEqual({ status: 'active', issues: [] });
  });

  it.each([
    ['outside', (artifactPath: string) => { writeFileSync(join(outside, 'run.json'), '{}'); symlinkSync(join(outside, 'run.json'), artifactPath); }],
    ['inside', (artifactPath: string) => { writeFileSync(join(root, 'real.json'), '{}'); symlinkSync(join(root, 'real.json'), artifactPath); }],
  ])('refuses an %s-root symlink without changing its target', (_name, link) => {
    // Given
    const fixture = writeValidationFixture(root);
    const artifact = fixture.manifest.artifacts[0];
    if (artifact === undefined) throw new Error('fixture artifact missing');
    const target = join(root, artifact.path);
    rmSync(target);
    link(target);
    const sentinelPath = join(outside, 'sentinel');
    writeFileSync(sentinelPath, 'unchanged');

    // When
    const result = validate(root, fixture);

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain('artifact_symlink');
    expect(readFileSync(sentinelPath, 'utf8')).toBe('unchanged');
  });

  it.each([
    ['digest', 'artifact_digest_mismatch', (path: string) => writeFileSync(path, '{"changed":true}')],
    ['size', 'artifact_size_mismatch', (path: string) => writeFileSync(path, 'x'.repeat(99))],
  ])('refuses %s drift from measured bytes', (_name, code, change) => {
    // Given
    const fixture = writeValidationFixture(root);
    const artifact = fixture.manifest.artifacts[0];
    if (artifact === undefined) throw new Error('fixture artifact missing');
    change(join(root, artifact.path));

    // When
    const result = validate(root, fixture);

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain(code);
  });

  it('refuses a sparse oversized artifact before reading its payload', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const artifact = fixture.manifest.artifacts[0];
    if (artifact === undefined) throw new Error('fixture artifact missing');
    truncateSync(join(root, artifact.path), MAX_EVIDENCE_ARTIFACT_BYTES + 1);

    // When
    const result = validate(root, fixture);

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain('artifact_too_large');
  });

  it('refuses a declared media type that disagrees with measured JSON content', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const first = fixture.manifest.artifacts[0];
    if (first === undefined) throw new Error('fixture artifact missing');
    const manifest = parseManifest({
      ...fixture.manifest,
      artifacts: [{ ...first, mediaType: 'text/plain' }, ...fixture.manifest.artifacts.slice(1)],
    });

    // When
    const result = validate(root, { ...fixture, manifest });

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain('artifact_media_type_mismatch');
  });

  it.each([
    ['firmware', (fixture: ValidationFixture) => ({ ...fixture.context, currentFirmware: { ...fixture.context.currentFirmware, versionRaw: firmwareValueSchema.parse('6.10.0R3') } })],
    ['recipe', (fixture: ValidationFixture) => ({ ...fixture.context, currentDigests: { ...fixture.context.currentDigests, recipeDigest: sha256Schema.parse('d'.repeat(64)) } })],
    ['tool', (fixture: ValidationFixture) => ({ ...fixture.context, currentDigests: { ...fixture.context.currentDigests, toolDigest: sha256Schema.parse('f'.repeat(64)) } })],
    ['runtime', (fixture: ValidationFixture) => ({ ...fixture.context, currentDigests: { ...fixture.context.currentDigests, runtimeDigest: sha256Schema.parse('e'.repeat(64)) } })],
  ])('marks %s identity drift stale immediately', (_name, drift) => {
    // Given
    const fixture = writeValidationFixture(root);

    // When
    const result = validate(root, fixture, drift(fixture));

    // Then
    expect(result.status).toBe('stale');
    expect(issueCodes(result)).toContain('identity_drift');
  });

  it('refuses firmware truth bytes that no longer match their declared digest', () => {
    // Given
    const fixture = writeValidationFixture(root);
    writeFileSync(join(root, fixture.manifest.firmwareTruth.evidenceFile), '{"version":"drift"}');

    // When
    const result = validate(root, fixture);

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain('firmware_evidence_digest_mismatch');
  });

  it('marks API evidence stale one millisecond after the 180-day boundary', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const context = { ...fixture.context, clock: { now: () => new Date('2027-02-21T12:00:00.001Z') } };

    // When
    const result = validate(root, fixture, context);

    // Then
    expect(result.status).toBe('stale');
    expect(issueCodes(result)).toContain('evidence_expired');
  });

  it('uses the 90-day boundary for browser and mutation campaigns', () => {
    // Given
    const browser = writeValidationFixture(root, 'browser');
    const atBoundary = { ...browser.context, clock: { now: () => new Date('2026-11-23T12:00:00.000Z') } };
    const afterBoundary = { ...atBoundary, clock: { now: () => new Date('2026-11-23T12:00:00.001Z') } };

    // When
    const active = validate(root, browser, atBoundary);
    const stale = validate(root, browser, afterBoundary);

    // Then
    expect(active.status).toBe('active');
    expect(stale.status).toBe('stale');
  });

  it('refuses advisory evidence without the honest ambiguous INDETERMINATE case', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const manifest = parseManifest({
      ...fixture.manifest,
      runs: fixture.manifest.runs.map((run) => ({ ...run, negativeCaseIds: [] })),
      artifacts: fixture.manifest.artifacts.filter(({ kind }) => kind !== 'negative'),
      negativeCases: [],
    });

    // When
    const result = validate(root, { ...fixture, manifest });

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toContain('required_negative_case_missing');
  });

  it('refuses reviewer collision and insufficient real-run/device diversity', () => {
    // Given
    const fixture = writeValidationFixture(root);
    const firstExecutor = fixture.manifest.runs[0]?.executor.actorId;
    if (firstExecutor === undefined) throw new Error('fixture run missing');
    const context = {
      ...fixture.context,
      reviewerActorId: firstExecutor,
      runIdentities: fixture.context.runIdentities.map((identity, index) => ({
        ...identity,
        environment: index === 0 ? 'real_device' as const : 'mock' as const,
        deviceIdentityDigest: fixture.context.runIdentities[0]?.deviceIdentityDigest ?? identity.deviceIdentityDigest,
      })),
    };

    // When
    const result = validate(root, fixture, context);

    // Then
    expect(result.status).toBe('refused');
    expect(issueCodes(result)).toEqual(expect.arrayContaining(['identity_role_conflict', 'insufficient_real_runs', 'insufficient_device_diversity']));
  });

  it('requires exactly two device and window identities for mutation diversity', () => {
    // Given
    const fixture = writeValidationFixture(root, 'mutation');
    const devices = new Set(fixture.context.runIdentities.map(({ deviceIdentityDigest }) => deviceIdentityDigest));
    const windows = new Set(fixture.context.runIdentities.map(({ windowIdentityDigest }) => windowIdentityDigest));

    // When
    const active = validate(root, fixture);
    const oneDevice = validate(root, fixture, {
      ...fixture.context,
      runIdentities: fixture.context.runIdentities.map((identity) => ({
        ...identity,
        deviceIdentityDigest: fixture.context.runIdentities[0]?.deviceIdentityDigest ?? identity.deviceIdentityDigest,
      })),
    });
    const oneWindow = validate(root, fixture, {
      ...fixture.context,
      runIdentities: fixture.context.runIdentities.map((identity) => ({
        ...identity,
        windowIdentityDigest: fixture.context.runIdentities[0]?.windowIdentityDigest ?? identity.windowIdentityDigest,
      })),
    });

    // Then
    expect(devices.size).toBe(2);
    expect(windows.size).toBe(2);
    expect(active).toEqual({ status: 'active', issues: [] });
    expect(issueCodes(oneDevice)).toEqual(['insufficient_device_diversity']);
    expect(issueCodes(oneWindow)).toEqual(['insufficient_window_diversity']);
  });

  it('activates complete mutation cycles and refuses retry, collateral, window, or negative-case failures', () => {
    // Given
    const fixture = writeValidationFixture(root, 'mutation');
    const firstRun = fixture.manifest.runs[0];
    if (firstRun === undefined) throw new Error('fixture run missing');
    const dirty = {
      ...fixture.manifest,
      runs: [{ ...firstRun, retryCount: 1, collateralMutationCount: 1 }, ...fixture.manifest.runs.slice(1)],
    };
    const incomplete = {
      ...fixture.manifest,
      runs: [{
        ...firstRun,
        independentReadBack: { ...firstRun.independentReadBack, result: 'fail' as const },
        postRunState: { ...firstRun.postRunState, result: 'fail' as const },
      }, ...fixture.manifest.runs.slice(1)],
    };
    const oneWindow = {
      ...fixture.context,
      runIdentities: fixture.context.runIdentities.map((identity) => ({ ...identity, windowIdentityDigest: fixture.context.runIdentities[0]?.windowIdentityDigest ?? identity.windowIdentityDigest })),
    };
    const missingNegative = { ...fixture.manifest, negativeCases: fixture.manifest.negativeCases.slice(0, -1) };

    // When
    const active = validate(root, fixture);
    const dirtyResult = validateCapabilityEvidence({ manifest: dirty, evidenceRoot: root, filesystem, context: fixture.context });
    const incompleteResult = validateCapabilityEvidence({ manifest: incomplete, evidenceRoot: root, filesystem, context: fixture.context });
    const windowResult = validate(root, fixture, oneWindow);
    const negativeResult = validateCapabilityEvidence({ manifest: missingNegative, evidenceRoot: root, filesystem, context: fixture.context });

    // Then
    expect(active.status).toBe('active');
    expect(issueCodes(dirtyResult)).toEqual(expect.arrayContaining(['retry_detected', 'collateral_mutation_detected']));
    expect(issueCodes(incompleteResult)).toEqual(expect.arrayContaining(['independent_readback_incomplete', 'restore_or_retain_incomplete']));
    expect(issueCodes(windowResult)).toContain('insufficient_window_diversity');
    expect(issueCodes(negativeResult)).toContain('required_negative_case_missing');
  });
});
