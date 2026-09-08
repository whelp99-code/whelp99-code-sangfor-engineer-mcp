/**
 * Blocker 6 — the report CLI has a closed flag surface and no hardcoded tools.
 *
 * A typo'd flag that is silently ignored is worse than a crash: `--stict --json`
 * printed an exit-0 report while the operator believed strict mode was on. And a
 * hardcoded DEFAULT_TOOLS list meant the CLI graded claims against names it made
 * up rather than the census the server advertises.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPromotionLedger } from './helpers/local-write-authority.js';
import {
  FilePromotionLedger,
  capabilityEvidenceManifestSchema,
  maskedPromotionRef,
} from '../packages/sangfor-competency/src/index.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'report-project-completeness.ts');

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const mkRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'report-cli-')); roots.push(d); return d; };

const startFakeBridge = async (names: readonly string[]): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tools: names.map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'] },
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

/**
 * Spawned asynchronously on purpose: the fake bridge lives in THIS process, so a
 * blocking spawnSync would hold the event loop and the CLI could never be served.
 */
const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<CliRun> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

/** A catalog whose single claim is grounded by the committed active Todo 8 fixture. */
const validCatalog = (): string => {
  const catalogRoot = mkRoot();
  writeFileSync(join(catalogRoot, 'capability-maturity.json'), JSON.stringify({
    version: 1,
    entries: [{ product: 'HCI_SCP', capabilityId: 'resource_inventory', maturity: 'tested_mock' }],
  }));
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({
    version: 1,
    atoms: [{
      id: 'op_daily_health', product: 'HCI_SCP', phase: 'operate', title: 'daily health',
      automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified',
      evidence: 'runs/run-1.json', capabilityRef: { product: 'HCI_SCP', capabilityId: 'resource_inventory' },
    }],
  }));
  return catalogRoot;
};

const effectiveAuthority = async (
  state: 'active' | 'stale' | 'drift' | 'demoted' = 'active',
): Promise<{ readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly evidenceRoot: string; readonly ledgerPath: string }> => {
  const fixtureRoot = join(REPO_ROOT, 'tests', 'fixtures', 'capability-evidence');
  const evidenceRoot = join(fixtureRoot, 'evidence');
  const manifestPath = join(fixtureRoot, 'active-advisory-manifest.json');
  let contextPath = join(evidenceRoot, 'validation-context.json');
  if (state === 'stale' || state === 'drift') {
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    contextPath = join(mkRoot(), 'validation-context.json');
    const currentDigests = context['currentDigests'];
    const driftedDigests = typeof currentDigests === 'object' && currentDigests !== null
      ? { ...currentDigests, runtimeDigest: 'e'.repeat(64) }
      : currentDigests;
    writeFileSync(contextPath, JSON.stringify(state === 'stale'
      ? { ...context, evaluatedAt: '2027-02-21T12:00:00.001Z' }
      : { ...context, currentDigests: driftedDigests }));
  }
  const manifestSource = readFileSync(manifestPath, 'utf8');
  const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(manifestSource));
  const ledgerPath = join(mkRoot(), 'promotion.jsonl');
  const ledgerSecret = 'report-cli-ledger-secret-at-least-32-bytes';
  const checkpointSecret = 'report-cli-checkpoint-secret-at-least-32';
  const ledger = await testPromotionLedger(ledgerPath, ledgerSecret, checkpointSecret);
  const manifestRef = maskedPromotionRef('manifest', createHash('sha256').update(manifestSource).digest('hex'));
  await ledger.append({
    version: 1, eventId: 'event-report-cli', at: '2026-08-25T13:00:00.000Z', outcome: 'applied', action: 'promote',
    target: manifest.target, fromMaturity: 'tested_mock', toMaturity: 'field_verified',
    decisionRef: maskedPromotionRef('decision', 'report-cli'), manifestRef,
    nonceRef: maskedPromotionRef('nonce', 'report-cli'), refusalCode: null,
  });
  if (state === 'demoted') {
    await ledger.append({
      version: 1, eventId: 'event-report-cli-demotion', at: '2026-08-25T14:00:00.000Z', outcome: 'applied', action: 'emergency_demote',
      target: manifest.target, fromMaturity: 'field_verified', toMaturity: 'tested_mock',
      decisionRef: maskedPromotionRef('decision', 'report-cli-demotion'), manifestRef,
      nonceRef: maskedPromotionRef('nonce', 'report-cli-demotion'), refusalCode: null,
    });
  }
  return {
    evidenceRoot,
    ledgerPath,
    args: ['--evidence-manifest', manifestPath, '--validation-context', contextPath, '--promotion-ledger', ledgerPath],
    env: {
      SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET: ledgerSecret,
      SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET: checkpointSecret,
    },
  };
};

describe('report CLI — closed flag surface', () => {
  it('Given an unknown flag, When the CLI runs, Then it exits nonzero and names the flag instead of ignoring it', async () => {
    const result = await run(['--stict', '--json']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--stict');
  });

  it('Given a value-taking flag with no value, When the CLI runs, Then it exits nonzero rather than consuming the next flag', async () => {
    const result = await run(['--catalog-root', '--json']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--catalog-root');
  });

  it('Given a trailing value-taking flag with nothing after it, When the CLI runs, Then it exits nonzero', async () => {
    const result = await run(['--evidence-root']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--evidence-root');
  });

  it('Given a bare positional argument, When the CLI runs, Then it is refused rather than silently dropped', async () => {
    const result = await run(['whoops']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('whoops');
  });
});

describe('report CLI — tools come from the canonical live registry', () => {
  it('Given a bridge advertising the covering tool, When the CLI runs strict, Then it exits 0 with one grounded report', async () => {
    const authority = await effectiveAuthority();
    const catalogRoot = validCatalog();
    const registryUrl = await startFakeBridge(['sangfor_evaluate_config']);

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', authority.evidenceRoot, '--registry-url', registryUrl, ...authority.args], authority.env);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; report: { replacedAtoms: number; automatableAtoms: number } };
    expect(payload.ok).toBe(true);
    expect(payload.report.replacedAtoms).toBe(1);
    expect(payload.report.automatableAtoms).toBe(1);
  });

  it.each([
    ['stale', 'stale'],
    ['drift', 'stale'],
    ['demoted', 'demoted'],
  ] as const)('Given %s effective authority, When the CLI runs strict, Then it lowers the numerator and reports the explicit state', async (authorityState, expectedState) => {
    const authority = await effectiveAuthority(authorityState);
    const catalogRoot = validCatalog();
    const registryUrl = await startFakeBridge(['sangfor_evaluate_config']);

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', authority.evidenceRoot, '--registry-url', registryUrl, ...authority.args], authority.env);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as { report: { replacedAtoms: number; automatableAtoms: number; claimIssues: readonly { state: string }[] } };
    expect(payload.report.replacedAtoms).toBe(0);
    expect(payload.report.automatableAtoms).toBe(1);
    expect(payload.report.claimIssues).toEqual([expect.objectContaining({ state: expectedState })]);
  });

  it('Given a corrupt authenticated checkpoint, When the CLI runs strict, Then it refuses the report without a rate', async () => {
    const authority = await effectiveAuthority();
    const catalogRoot = validCatalog();
    const registryUrl = await startFakeBridge(['sangfor_evaluate_config']);
    writeFileSync(`${authority.ledgerPath}.head.json`, '{}');

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', authority.evidenceRoot, '--registry-url', registryUrl, ...authority.args], authority.env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('promotionLedgerUnavailable');
    expect(result.stdout).not.toContain('replacementRate');
  });

  it('Given a bridge that does NOT advertise the covering tool, When the CLI runs strict, Then it refuses — no hardcoded name rescues the claim', async () => {
    const authority = await effectiveAuthority();
    const catalogRoot = validCatalog();
    const registryUrl = await startFakeBridge(['sangfor_suggest_rca']);

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', authority.evidenceRoot, '--registry-url', registryUrl, ...authority.args], authority.env);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; violations: readonly { kind: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.violations.map((v) => v.kind)).toEqual(['unregisteredTool']);
  });

  it('Given no reachable registry, When the CLI runs strict, Then it exits nonzero with a reachability violation and no rate', async () => {
    const evidenceRoot = mkRoot();
    const catalogRoot = validCatalog();

    const result = await run(['--strict', '--json', '--catalog-root', catalogRoot, '--evidence-root', evidenceRoot, '--registry-url', 'http://127.0.0.1:1']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('registryUnreachable');
    expect(result.stdout).not.toContain('replacementRate');
  });
});
