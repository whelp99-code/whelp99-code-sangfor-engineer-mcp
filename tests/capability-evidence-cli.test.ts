import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CAPABILITY_EVIDENCE_BYTES,
  capabilityEvidenceManifestSchema,
} from '../packages/sangfor-competency/src/index.js';

const CLI = 'scripts/capability-evidence-cli.ts';
const VALID = 'tests/fixtures/capability-evidence/valid-manifest.json';
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

function runCli(manifestPath: string, registryUrl: string, catalogRoot: string = GROUNDING_ROOT): Promise<CliResult> {
  const child = spawn('pnpm', ['exec', 'tsx', CLI, 'parse', '--manifest', manifestPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SANGFOR_HTTP_BRIDGE_URL: registryUrl,
      SANGFOR_COMPETENCY_ROOT: catalogRoot,
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
    const result = await runCli(manifestPath, registryUrl, REPO_CATALOG_ROOT);

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
});
