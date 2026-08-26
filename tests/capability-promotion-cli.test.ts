import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilePromotionLedger,
  capabilityPromotionCliOutput,
  capabilityPromotionEnvelopeSchema,
  canonicalizeCapabilityApproval,
  deriveEffectiveMaturity,
  signCapabilityApproval,
} from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './helpers/capability-evidence-validation-fixture.js';

const CLI = 'scripts/capability-evidence-cli.ts';
const APPROVAL_SECRET = 'capability-cli-approval-secret-32-bytes';
const LEDGER_SECRET = 'capability-cli-ledger-secret-material-32';
const CHECKPOINT_SECRET = 'capability-cli-checkpoint-secret-material';
const TOOL_CENSUS = JSON.stringify({
  tools: [{
    name: 'sangfor_evaluate_config', description: 'fixture', inputSchema: { type: 'object' },
    annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false }, category: 'test',
  }],
});

type CliResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function runCli(paths: {
  readonly manifest: string;
  readonly promotion: string;
  readonly evidenceRoot: string;
  readonly context: string;
  readonly nonce: string;
  readonly ledger: string;
}, registryUrl: string): Promise<CliResult> {
  const child = spawn('pnpm', [
    'exec', 'tsx', CLI, 'promote', '--manifest', paths.manifest,
    '--promotion', paths.promotion, '--evidence-root', paths.evidenceRoot,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SANGFOR_HTTP_BRIDGE_URL: registryUrl,
      SANGFOR_COMPETENCY_ROOT: new URL('./fixtures/capability-evidence/grounding/', import.meta.url).pathname,
      SANGFOR_CAPABILITY_EVIDENCE_CONTEXT: paths.context,
      SANGFOR_CAPABILITY_PROMOTION_SECRET: APPROVAL_SECRET,
      SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET: LEDGER_SECRET,
      SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET: CHECKPOINT_SECRET,
      SANGFOR_CAPABILITY_PROMOTION_NONCE_STORE_PATH: paths.nonce,
      SANGFOR_CAPABILITY_PROMOTION_LEDGER_PATH: paths.ledger,
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

function signedPromotion(manifestSource: string, manifest: ReturnType<typeof writeValidationFixture>['manifest']): string {
  const request = {
    version: 1, requestId: 'cli-request-1', manifestId: manifest.manifestId,
    manifestDigest: createHash('sha256').update(manifestSource).digest('hex'), target: manifest.target,
    fromMaturity: 'tested_mock', requestedMaturity: 'field_verified', requestedBy: { actorId: 'cli-requester', actorType: 'ai_engineer' },
    requestedAt: '2026-08-25T12:05:00.000Z', evidenceRef: 'manifest.json', auditRef: 'request.jsonl',
    o5Counters: manifest.o5Counters,
  } as const;
  const envelope = capabilityPromotionEnvelopeSchema.parse({
    version: 1, request,
    decision: {
      version: 1, decisionId: 'cli-decision-1', requestId: request.requestId, manifestId: request.manifestId,
      manifestDigest: request.manifestDigest, target: request.target, o5Counters: request.o5Counters,
      fromMaturity: request.fromMaturity, reviewer: { actorId: 'human-reviewer-1', actorType: 'human_pm' }, decidedAt: '2026-08-25T12:10:00.000Z',
      auditRef: 'decision.jsonl', approvalDigest: '0'.repeat(64), nonce: 'cli-nonce-1',
      expiresAt: '2026-08-25T12:20:00.000Z', decision: 'promote', promotedMaturity: 'field_verified',
    },
  });
  const decision = envelope.decision;
  if (decision === null) throw new Error('decision fixture missing');
  const approvalDigest = signCapabilityApproval(APPROVAL_SECRET, canonicalizeCapabilityApproval(envelope));
  return JSON.stringify({ ...envelope, decision: { ...decision, approvalDigest } });
}

describe('capability promotion CLI', () => {
  let root: string;
  let registry: Server;
  let registryUrl: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'capability-promotion-cli-'));
    registry = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(TOOL_CENSUS);
    });
    const listening = new Promise<void>((resolve) => registry.once('listening', resolve));
    registry.listen(0, '127.0.0.1');
    await listening;
    const address = registry.address();
    if (address === null || typeof address === 'string') throw new Error('fixture registry unavailable');
    registryUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('maps unknown state and a corrupt checkpoint to INDETERMINATE without maturity output', async () => {
    const evidenceRoot = join(root, 'corrupt-evidence');
    const fixture = writeValidationFixture(evidenceRoot);
    const manifest = join(root, 'corrupt-manifest.json');
    const promotion = join(root, 'corrupt-promotion.json');
    const context = join(root, 'corrupt-context.json');
    const nonce = join(root, 'corrupt-nonces.json');
    const ledgerPath = join(root, 'corrupt-ledger.jsonl');
    const manifestSource = JSON.stringify(fixture.manifest);
    writeFileSync(manifest, manifestSource);
    writeFileSync(promotion, signedPromotion(manifestSource, fixture.manifest));
    writeFileSync(nonce, JSON.stringify({ consumed: [] }));
    writeFileSync(context, JSON.stringify({
      campaign: fixture.context.campaign, evaluatedAt: '2026-08-25T12:10:00.000Z',
      currentFirmware: fixture.context.currentFirmware, currentDigests: fixture.context.currentDigests,
      reviewer: { actorId: fixture.context.reviewerActorId, actorType: 'human_pm' },
      runIdentities: fixture.context.runIdentities,
    }));
    FilePromotionLedger.initialize(ledgerPath, LEDGER_SECRET, CHECKPOINT_SECRET);
    writeFileSync(`${ledgerPath}.head.json`, '{');

    const indeterminate = capabilityPromotionCliOutput({ status: 'indeterminate', reason: 'ledger_commit_unknown' });
    const corrupt = await runCli({ manifest, promotion, evidenceRoot, context, nonce, ledger: ledgerPath }, registryUrl);

    expect(indeterminate).toEqual({ exitCode: 2, stdout: '', stderr: 'CAPABILITY_PROMOTION_INDETERMINATE\n' });
    expect(corrupt).toMatchObject({ status: 2, stdout: '', stderr: 'CAPABILITY_PROMOTION_INDETERMINATE\n' });
    expect(corrupt.stderr).not.toContain('Maturity');
  });

  it('prints APPLIED once, then REFUSED on replay with event-derived maturity unchanged', async () => {
    const evidenceRoot = join(root, 'evidence');
    const fixture = writeValidationFixture(evidenceRoot);
    const manifest = join(root, 'manifest.json');
    const promotion = join(root, 'promotion.json');
    const context = join(root, 'context.json');
    const nonce = join(root, 'nonces.json');
    const ledgerPath = join(root, 'ledger.jsonl');
    const manifestSource = JSON.stringify(fixture.manifest);
    writeFileSync(manifest, manifestSource);
    writeFileSync(promotion, signedPromotion(manifestSource, fixture.manifest));
    writeFileSync(nonce, JSON.stringify({ consumed: [] }));
    writeFileSync(context, JSON.stringify({
      campaign: fixture.context.campaign, evaluatedAt: '2026-08-25T12:10:00.000Z',
      currentFirmware: fixture.context.currentFirmware, currentDigests: fixture.context.currentDigests,
      reviewer: { actorId: fixture.context.reviewerActorId, actorType: 'human_pm' },
      runIdentities: fixture.context.runIdentities,
    }));
    const ledger = FilePromotionLedger.initialize(ledgerPath, LEDGER_SECRET, CHECKPOINT_SECRET);

    const applied = await runCli({ manifest, promotion, evidenceRoot, context, nonce, ledger: ledgerPath }, registryUrl);
    const replayed = await runCli({ manifest, promotion, evidenceRoot, context, nonce, ledger: ledgerPath }, registryUrl);

    expect(applied).toMatchObject({ status: 0, stdout: 'CAPABILITY_PROMOTION_APPLIED\n', stderr: '' });
    expect(replayed.status).toBe(1);
    expect(replayed.stderr).toContain('CAPABILITY_PROMOTION_REFUSED');
    expect(ledger.read()).toHaveLength(2);
    expect(deriveEffectiveMaturity('tested_mock', fixture.manifest.target, ledger.read())).toBe('field_verified');
    const output = `${applied.stdout}${applied.stderr}${replayed.stdout}${replayed.stderr}${readFileSync(ledgerPath, 'utf8')}${readFileSync(`${ledgerPath}.head.json`, 'utf8')}`;
    expect(output).not.toContain(APPROVAL_SECRET);
    expect(output).not.toContain('cli-nonce-1');
  });
});
