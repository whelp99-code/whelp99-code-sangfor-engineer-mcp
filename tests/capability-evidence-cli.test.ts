import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CAPABILITY_EVIDENCE_BYTES,
  capabilityEvidenceManifestSchema,
  type EvidenceValidationContext,
} from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './helpers/capability-evidence-validation-fixture.js';

const CLI = 'scripts/capability-evidence-cli.ts';
const VALID = 'tests/fixtures/capability-evidence/valid-manifest.json';
const RETAINED_MANIFEST = 'tests/fixtures/capability-evidence/active-retained-mutation-manifest.json';
const RETAINED_ROOT = 'tests/fixtures/capability-evidence/retained-evidence';
const RETAINED_CONTEXT = `${RETAINED_ROOT}/validation-context.json`;
const GROUNDING_ROOT = fileURLToPath(new URL('./fixtures/capability-evidence/grounding', import.meta.url));
const REPO_CATALOG_ROOT = fileURLToPath(new URL('../data/competency', import.meta.url));
const TOOL_CENSUS = JSON.stringify({
  tools: [{
    name: 'sangfor_evaluate_config',
    description: 'fixture',
    inputSchema: { type: 'object' },
    annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false },
    category: 'test',
  }],
});

type CliResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
type RunCliOptions = {
  readonly catalogRoot?: string;
  readonly verification?: { readonly evidenceRoot: string; readonly contextPath: string };
};

function runCli(manifestPath: string, registryUrl: string, options: RunCliOptions = {}): Promise<CliResult> {
  const { verification } = options;
  const args = verification === undefined
    ? ['exec', 'tsx', CLI, 'parse', '--manifest', manifestPath]
    : ['exec', 'tsx', CLI, 'verify', '--manifest', manifestPath, '--evidence-root', verification.evidenceRoot];
  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SANGFOR_HTTP_BRIDGE_URL: registryUrl,
      SANGFOR_COMPETENCY_ROOT: options.catalogRoot ?? GROUNDING_ROOT,
      ...(verification === undefined ? {} : { SANGFOR_CAPABILITY_EVIDENCE_CONTEXT: verification.contextPath }),
    },
  });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function writeCliContext(path: string, context: EvidenceValidationContext, evaluatedAt: string): void {
  writeFileSync(path, JSON.stringify({
    campaign: context.campaign,
    evaluatedAt,
    currentFirmware: context.currentFirmware,
    currentDigests: context.currentDigests,
    reviewer: { actorId: context.reviewerActorId, actorType: 'human_pm' },
    runIdentities: context.runIdentities,
  }));
}

describe('capability evidence parse CLI', () => {
  let tempRoot: string;
  let registryUrl: string;
  let registry: Server;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'capability-evidence-cli-'));
    registry = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(TOOL_CENSUS);
    });
    const listening = new Promise<void>((resolve) => registry.once('listening', resolve));
    registry.listen(0, '127.0.0.1');
    await listening;
    const address = registry.address();
    if (address === null || typeof address === 'string') throw new Error('fixture registry did not bind TCP');
    registryUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const closed = new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    await closed;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prints the stable schema PASS sentinel for a valid grounded manifest', async () => {
    // Given
    const manifestPath = VALID;

    // When
    const result = await runCli(manifestPath, registryUrl);

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('CAPABILITY_EVIDENCE_SCHEMA_PASS');
    expect(result.stderr).toBe('');
  });

  it('honestly refuses the current repo catalog because it has no invented capability binding', async () => {
    // Given
    const manifestPath = VALID;

    // When
    const result = await runCli(manifestPath, registryUrl, { catalogRoot: REPO_CATALOG_ROOT });

    // Then
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'refused', violations: [{ code: 'capability_mismatch' }] });
  });

  it('returns typed refusal without persisting or echoing rejected secret input', async () => {
    // Given
    const secret = 'Bearer customer-secret-value';
    const path = join(tempRoot, 'adversarial.json');
    const validSource = readFileSync(VALID, 'utf8').trimEnd();
    const source = `${validSource.slice(0, -1)},\n"authorization":${JSON.stringify(secret)}\n}\n`;
    writeFileSync(path, source);
    const before = readdirSync(tempRoot);

    // When
    const result = await runCli(path, registryUrl);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'refused', violations: [{ code: 'schema_mismatch' }] });
    expect(result.stderr).not.toContain(secret);
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(readdirSync(tempRoot)).toEqual(before);
  });

  it('refuses invented catalog references instead of printing PASS', async () => {
    // Given
    const path = join(tempRoot, 'invented.json');
    const value = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(VALID, 'utf8')));
    writeFileSync(path, JSON.stringify({ ...value, target: { ...value.target, workAtomIds: ['invented_atom'] } }));

    // When
    const result = await runCli(path, registryUrl);

    // Then
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'refused', violations: [{ code: 'unknown_work_atom' }] });
  });

  it('refuses a manifest over the measured byte cap before parsing payload volume', async () => {
    // Given
    const path = join(tempRoot, 'oversized.json');
    const source = readFileSync(VALID, 'utf8');
    writeFileSync(path, `${source}${' '.repeat(MAX_CAPABILITY_EVIDENCE_BYTES - Buffer.byteLength(source) + 1)}`);

    // When
    const result = await runCli(path, registryUrl);

    // Then
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'refused', violations: [{ code: 'manifest_too_large', path: [] }] });
  });

  it('classifies malformed JSON without writing a generated manifest', async () => {
    // Given
    const path = join(tempRoot, 'malformed.json');
    writeFileSync(path, '{"version":1');

    // When
    const result = await runCli(path, registryUrl);

    // Then
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'refused', violations: [{ code: 'malformed_json', path: [] }] });
    expect(readdirSync(tempRoot)).toEqual(['malformed.json']);
  });

  it('prints the ACTIVE sentinel only after physical evidence verification', async () => {
    // Given
    const evidenceRoot = join(tempRoot, 'evidence');
    const fixture = writeValidationFixture(evidenceRoot);
    const manifestPath = join(tempRoot, 'manifest.json');
    const contextPath = join(tempRoot, 'context.json');
    writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
    writeCliContext(contextPath, fixture.context, '2026-08-25T12:00:00.000Z');

    // When
    const result = await runCli(manifestPath, registryUrl, { verification: { evidenceRoot, contextPath } });

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('CAPABILITY_EVIDENCE_ACTIVE');
    expect(result.stderr).toBe('');
  });

  it('verifies committed retained mutation approval artifacts and refuses nonexistent refs', async () => {
    // Given
    const missingPath = join(tempRoot, 'missing-retention.json');
    const retained = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(RETAINED_MANIFEST, 'utf8')));
    const retentionIds = new Set(retained.artifacts.filter(({ kind }) => kind === 'retention_approval').map(({ id }) => id));
    writeFileSync(missingPath, JSON.stringify({
      ...retained,
      runs: retained.runs.map((run) => ({ ...run, artifactIds: run.artifactIds.filter((id) => !retentionIds.has(id)) })),
      artifacts: retained.artifacts.filter(({ id }) => !retentionIds.has(id)),
    }));

    // When
    const active = await runCli(RETAINED_MANIFEST, registryUrl, { verification: { evidenceRoot: RETAINED_ROOT, contextPath: RETAINED_CONTEXT } });
    const refused = await runCli(missingPath, registryUrl, { verification: { evidenceRoot: RETAINED_ROOT, contextPath: RETAINED_CONTEXT } });

    // Then
    expect(active.status).toBe(0);
    expect(active.stdout.trim()).toBe('CAPABILITY_EVIDENCE_ACTIVE');
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ status: 'refused', message: 'CAPABILITY_EVIDENCE_REFUSED' });
  });

  it('returns typed nonzero STALE and REFUSED outcomes without persistence', async () => {
    // Given
    const evidenceRoot = join(tempRoot, 'evidence');
    const fixture = writeValidationFixture(evidenceRoot);
    const manifestPath = join(tempRoot, 'manifest.json');
    const contextPath = join(tempRoot, 'context.json');
    writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
    writeCliContext(contextPath, fixture.context, '2027-02-21T12:00:00.001Z');
    const before = readdirSync(tempRoot).sort();

    // When
    const stale = await runCli(manifestPath, registryUrl, { verification: { evidenceRoot, contextPath } });
    writeCliContext(contextPath, fixture.context, '2026-08-25T12:00:00.000Z');
    const artifact = fixture.manifest.artifacts[0];
    if (artifact === undefined) throw new Error('fixture artifact missing');
    const artifactPath = join(evidenceRoot, artifact.path);
    rmSync(artifactPath);
    symlinkSync(join(evidenceRoot, fixture.manifest.artifacts[1]?.path ?? ''), artifactPath);
    const refused = await runCli(manifestPath, registryUrl, { verification: { evidenceRoot, contextPath } });

    // Then
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr)).toMatchObject({ status: 'stale', message: 'CAPABILITY_EVIDENCE_STALE' });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ status: 'refused', message: 'CAPABILITY_EVIDENCE_REFUSED', violations: [{ code: 'artifact_symlink' }] });
    expect(readdirSync(tempRoot).sort()).toEqual(before);
  });
});
