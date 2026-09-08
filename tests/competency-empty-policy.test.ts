/**
 * FIX B — an empty maturity policy cannot ground a report.
 *
 * A policy with zero entries is indistinguishable from "no policy": every
 * capabilityRef misses it, so nothing can ever be confirmed. Left permitted, it
 * is the quietest way to disable the maturity cross-check entirely — hand the
 * context an empty array and the strongest claim in the catalog faces no
 * contradiction. An empty policy is therefore refused, not tolerated.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoverageContext, loadMaturityPolicyStrict } from '../packages/sangfor-competency/src/index.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'report-project-completeness.ts');

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const mkRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'competency-empty-policy-')); roots.push(d); return d; };

const startFakeBridge = async (names: readonly string[]): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tools: names.map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { title: name, readOnlyHint: true, destructiveHint: false },
        category: 'advisory',
      })),
    }));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

interface CliRun { readonly status: number | null; readonly stdout: string; readonly stderr: string }
const run = (args: readonly string[]): Promise<CliRun> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

describe('loadMaturityPolicyStrict — a zero-entry policy file is refused', () => {
  it('Given a policy file declaring no entries, When loaded strictly, Then it is refused as schema-invalid', () => {
    const dir = mkRoot();
    writeFileSync(join(dir, 'capability-maturity.json'), JSON.stringify({ version: 1, entries: [] }));

    const loaded = loadMaturityPolicyStrict(dir);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.violations.map((v) => v.kind)).toEqual(['schemaInvalid']);
    expect(loaded).not.toHaveProperty('entries');
  });

  it('Given the curated policy file, When loaded strictly, Then it still parses', () => {
    const loaded = loadMaturityPolicyStrict(join(REPO_ROOT, 'data', 'competency'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.entries.length).toBeGreaterThan(0);
  });
});

describe('buildCoverageContext — an empty direct policy is refused', () => {
  it('Given maturityPolicy is an empty array, When a context is built, Then it throws instead of disabling the cross-check', () => {
    expect(() => buildCoverageContext({
      catalogRoot: mkRoot(),
      evidenceRoot: mkRoot(),
      registeredTools: ['sangfor_evaluate_config'],
      maturityPolicy: [],
    })).toThrow(/maturityPolicy/u);
  });

  it('Given a single declared capability, When a context is built, Then it succeeds', () => {
    expect(() => buildCoverageContext({
      catalogRoot: mkRoot(),
      evidenceRoot: mkRoot(),
      registeredTools: ['sangfor_evaluate_config'],
      maturityPolicy: [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' }],
    })).not.toThrow();
  });
});

describe('report CLI — an empty policy yields no metric', () => {
  it('Given a catalog whose policy declares no entries, When the CLI runs strict, Then it refuses and prints no rate', async () => {
    const catalogRoot = mkRoot();
    const evidenceRoot = mkRoot();
    writeFileSync(join(evidenceRoot, 'capture.md'), '# real capture\n');
    writeFileSync(join(catalogRoot, 'capability-maturity.json'), JSON.stringify({ version: 1, entries: [] }));
    writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({
      version: 1,
      atoms: [{
        id: 'op_daily_health',
        product: 'IAG',
        phase: 'operate',
        title: 'daily health',
        automatability: 'auto',
        coveredBy: 'sangfor_evaluate_config',
        maturity: 'field_verified',
        evidence: 'capture.md',
        capabilityRef: { product: 'IAG', capabilityId: 'auth_source' },
      }],
    }));
    const registryUrl = await startFakeBridge(['sangfor_evaluate_config']);

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', evidenceRoot, '--registry-url', registryUrl]);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; violations: readonly { kind: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.violations.map((v) => v.kind)).toEqual(['schemaInvalid']);
    expect(result.stdout).not.toContain('replacementRate');
  });
});
