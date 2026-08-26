import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePromotionLedger } from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './helpers/capability-evidence-validation-fixture.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'capability-evidence-cli.ts');
const LEDGER_SECRET = 'stale-cli-ledger-secret-material-32-bytes';
const CHECKPOINT_SECRET = 'stale-cli-checkpoint-secret-material-32';

type CliResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

describe('capability stale CLI', () => {
  let root: string;
  let server: Server;
  let registryUrl: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'capability-stale-cli-'));
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tools: [{
        name: 'sangfor_evaluate_config', description: 'fixture', inputSchema: { type: 'object' },
        annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false }, category: 'test',
      }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('registry fixture unavailable');
    registryUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: readonly string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', ['--import', 'tsx', CLI, ...args], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SANGFOR_HTTP_BRIDGE_URL: registryUrl,
          SANGFOR_COMPETENCY_ROOT: join(REPO_ROOT, 'tests', 'fixtures', 'capability-evidence', 'grounding'),
          SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET: LEDGER_SECRET,
          SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET: CHECKPOINT_SECRET,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  function authority(evaluatedAt: string) {
    const evidenceRoot = join(root, `evidence-${evaluatedAt.slice(0, 10)}`);
    const fixture = writeValidationFixture(evidenceRoot);
    const manifestPath = join(root, `manifest-${evaluatedAt.slice(0, 10)}.json`);
    const contextPath = join(root, `context-${evaluatedAt.slice(0, 10)}.json`);
    const ledgerPath = join(root, `ledger-${evaluatedAt.slice(0, 10)}.jsonl`);
    writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
    writeFileSync(contextPath, JSON.stringify({
      campaign: fixture.context.campaign,
      evaluatedAt,
      currentFirmware: fixture.context.currentFirmware,
      currentDigests: fixture.context.currentDigests,
      reviewer: { actorId: fixture.context.reviewerActorId, actorType: 'human_pm' },
      runIdentities: fixture.context.runIdentities,
    }));
    const ledger = FilePromotionLedger.initialize(ledgerPath, LEDGER_SECRET, CHECKPOINT_SECRET);
    const args = [
      'stale', '--manifest', manifestPath, '--validation-context', contextPath,
      '--evidence-root', evidenceRoot, '--promotion-ledger', ledgerPath,
    ];
    return { args, ledger, ledgerPath };
  }

  it('Given active exact authority, When stale validation runs, Then it reports no change and appends nothing', async () => {
    const value = authority('2026-08-25T12:00:00.000Z');

    const result = await run(value.args);

    expect(result).toEqual({ status: 0, stdout: 'CAPABILITY_EVIDENCE_NO_CHANGE\n', stderr: '' });
    expect(value.ledger.read()).toEqual([]);
  });

  it('Given genuinely expired evidence, When stale validation runs, Then Todo 10 persists one conservative invalidation', async () => {
    const value = authority('2027-02-21T12:00:00.001Z');

    const result = await run(value.args);

    expect(result).toEqual({ status: 0, stdout: 'CAPABILITY_EVIDENCE_STALE_PERSISTED\n', stderr: '' });
    expect(value.ledger.read()).toEqual([expect.objectContaining({ action: 'stale', outcome: 'applied' })]);
  });

  it('Given caller stale flags or extra arguments, When stale runs, Then it refuses without touching the ledger', async () => {
    const value = authority('2026-08-25T12:00:00.000Z');
    const before = readFileSync(value.ledgerPath, 'utf8');

    const result = await run([...value.args, '--stale', 'true']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readFileSync(value.ledgerPath, 'utf8')).toBe(before);
    expect(value.ledger.read()).toEqual([]);
  });
});
