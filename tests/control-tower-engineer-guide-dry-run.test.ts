import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureIagOrchestratorToolService } from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { proposeEngineerGuideApply } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import { writeEngineerGuideApplyFile } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-file.js';
import type { EngineerGuide } from '../packages/shared/src/engineer-case-contract.js';
import { evaluateEngineerFieldAcceptance } from '../packages/shared/src/engineer-field-acceptance.js';
import { computeEngineerGuideDigest } from '../packages/shared/src/engineer-guide-digest.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import { configureIagMcpFixture } from './helpers/iag-mcp-tool-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
  IAG_ORCHESTRATOR_LEDGER_SECRET,
} from './helpers/iag-orchestrator-fixture.js';

process.env.MCP_NO_SERVE = '1';

let root = '';
let runsDir = '';
let registryDir = '';
let tower: http.Server | undefined;
let bridge: http.Server | undefined;
let towerUrl = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tower-e13-guide-dry-run-'));
  runsDir = mkdtempSync(join(tmpdir(), 'tower-e13-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'tower-e13-reg-'));
  configureIagOrchestratorTestEnvironment(root);
  process.env.SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET = IAG_ORCHESTRATOR_LEDGER_SECRET;
  process.env.SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET = IAG_ORCHESTRATOR_CHECKPOINT_SECRET;
});

afterEach(async () => {
  if (tower !== undefined) {
    await new Promise<void>((resolve) => tower?.close(() => resolve()));
    tower = undefined;
  }
  if (bridge !== undefined) {
    await new Promise<void>((resolve) => bridge?.close(() => resolve()));
    bridge = undefined;
  }
  configureIagOrchestratorToolService(undefined);
  cleanupTestIagMutationAuthorityEnvironment();
  for (const key of [
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
    'SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET', 'SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

function guideOf(readiness: EngineerGuide['readiness'] = 'review_ready'): EngineerGuide {
  const withoutDigest = {
    revision: 'guide-e13-1',
    requirementRefs: ['req-url-exception'],
    steps: [{
      id: 'step-url-exception',
      order: 1,
      title: 'Add lab URL exception',
      requirementRefs: ['req-url-exception'],
      evidenceRefs: [],
      citations: [],
      verify: 'Independent IAG read-back of the exception',
      stop: 'Stop if pre-state drifts',
      recovery: 'Do not auto-rollback; replan',
    }],
    prerequisites: [],
    unresolved: [],
    readiness,
  } as const;
  return { ...withoutDigest, digest: computeEngineerGuideDigest(withoutDigest) };
}

const storedExecutableView = {
  stepId: 'step-url-exception',
  executable: true,
  support: 'executable',
} as const;

type StoredStepView = {
  readonly stepId: string;
  readonly executable: boolean;
  readonly support: 'executable' | 'blocked' | 'unsupported';
};

function persistGuideFile(
  outputPath: string,
  input: {
    readonly product?: 'IAG' | 'HCI';
    readonly guide?: EngineerGuide;
    readonly stepViews?: readonly StoredStepView[];
  } = {},
): void {
  writeEngineerGuideApplyFile({
    outputPath,
    product: input.product ?? 'IAG',
    guide: input.guide ?? guideOf(),
    stepViews: (input.stepViews ?? [storedExecutableView]).map((view) => ({
      step: { id: view.stepId },
      executable: view.executable,
      support: view.support,
    })),
  });
}

function writeGuideFiles(input: {
  readonly guide?: EngineerGuide | {
    readonly product: 'IAG' | 'HCI';
    readonly guide: EngineerGuide;
    readonly stepViews?: readonly StoredStepView[];
  };
  readonly observed: unknown;
}): { readonly guidePath: string; readonly observedPath: string } {
  const guidePath = join(root, 'guide.json');
  const observedPath = join(root, 'observed.json');
  if (input.guide === undefined) persistGuideFile(guidePath);
  else if ('guide' in input.guide) {
    persistGuideFile(guidePath, input.guide);
  } else persistGuideFile(guidePath, { guide: input.guide });
  writeFileSync(observedPath, JSON.stringify(input.observed));
  return { guidePath, observedPath };
}

async function startBoundTower(
  dryRunBoundToGuide: (input: unknown) => Promise<unknown>,
): Promise<string> {
  const server = createTowerServer({
    authorityMode: 'local',
    runsDir,
    registryDir,
    approvalSecret: 'tower-e13-secret',
    apiToken: 'test-token',
    mockConsoleUrl: 'http://127.0.0.1:1',
    guideBoundDryRun: dryRunBoundToGuide,
  });
  tower = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  towerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return towerUrl;
}

async function startProductionTower(
  onCall: (body: { readonly name: string; readonly arguments: Record<string, unknown> }) => Promise<unknown>,
): Promise<{ readonly recorded: string[] }> {
  const recorded: string[] = [];
  const stub = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        name: string;
        arguments: Record<string, unknown>;
      };
      recorded.push(body.name);
      try {
        const payload = await onCall(body);
        return respond(200, {
          result: { structuredContent: payload, content: [], isError: false },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return respond(400, { error: message });
      }
    }
    return respond(404, { error: 'not found' });
  });
  bridge = stub;
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  const bridgeUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const server = createTowerServer({
    authorityMode: 'local',
    runsDir,
    registryDir,
    approvalSecret: 'tower-e13-secret',
    apiToken: 'test-token',
    mockConsoleUrl: 'http://127.0.0.1:1',
    bridgeUrl,
  });
  tower = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  towerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { recorded };
}

async function post(path: string, body: unknown, token = 'test-token') {
  const response = await fetch(`${towerUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('control-tower guide-bound dry-run (E13 leftover)', () => {
  it('dry-runs one bound IAG guide step twice without dispatch, verified success, or field_accepted', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true, repeatPreflight: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const files = writeGuideFiles({ observed: refs.fixture.action.preState.observed });
    await startBoundTower((input) => refs.service.dryRunBoundToGuide(input));
    const args = {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    };

    const first = await post('/api/engineer-guide/dry-run', args);
    const second = await post('/api/engineer-guide/dry-run', args);

    for (const result of [first, second]) {
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true, mutationAttempted: false, verifiedSuccess: false,
        httpSuccessIgnored: true, retry: false,
      });
    }
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(evaluateEngineerFieldAcceptance({
      environmentKind: 'fixture',
      synthetic: true,
      guideReadiness: 'review_ready',
      developerTestPass: true,
      claimedFieldAccepted: true,
    })).toMatchObject({ fieldAccepted: false, grantPath: 'none' });
  });

  it('production default BridgeClient calls sangfor_engineer_guide_dry_run and never an apply tool', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const files = writeGuideFiles({ observed: refs.fixture.action.preState.observed });
    const { recorded } = await startProductionTower(async (body) => {
      if (body.name === 'sangfor_engineer_guide_apply' || body.name === 'sangfor_iag_exception_apply') {
        throw new Error(`UNEXPECTED_APPLY_TOOL:${body.name}`);
      }
      if (body.name !== 'sangfor_engineer_guide_dry_run') {
        throw new Error(`UNEXPECTED_TOOL:${body.name}`);
      }
      return refs.service.dryRunBoundToGuide(body.arguments);
    });

    const result = await post('/api/engineer-guide/dry-run', {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    });

    expect(recorded).toEqual(['sangfor_engineer_guide_dry_run']);
    expect(recorded).not.toContain('sangfor_engineer_guide_apply');
    expect(recorded).not.toContain('sangfor_iag_exception_apply');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true, mutationAttempted: false, verifiedSuccess: false,
      httpSuccessIgnored: true, retry: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses an approval envelope, apply, and dryRun:false without dispatch', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const files = writeGuideFiles({ observed: refs.fixture.action.preState.observed });
    await startBoundTower((input) => refs.service.dryRunBoundToGuide(input));
    const base = {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    };

    expect(await post('/api/engineer-guide/dry-run', {
      ...base, approvalEnvelopePath: refs.approvalEnvelopePath,
    })).toMatchObject({ status: 400, body: { error: 'IAG_DRY_RUN_APPROVAL_REFUSED' } });
    expect(await post('/api/engineer-guide/dry-run', {
      ...base, approval: { nonce: 'n' },
    })).toMatchObject({ status: 400, body: { error: 'IAG_DRY_RUN_APPROVAL_REFUSED' } });
    expect(await post('/api/engineer-guide/dry-run', { ...base, apply: true }))
      .toMatchObject({ status: 400, body: { error: 'IAG_GUIDE_APPLY_REFUSED' } });
    expect(await post('/api/engineer-guide/dry-run', { ...base, dryRun: false }))
      .toMatchObject({ status: 400, body: { error: 'IAG_DRY_RUN_ACTION_REQUIRED' } });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses live apply action files without dispatch or an apply tool', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false });
    const files = writeGuideFiles({ observed: refs.fixture.action.preState.observed });
    await startBoundTower((input) => refs.service.dryRunBoundToGuide(input));

    expect(await post('/api/engineer-guide/dry-run', {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    })).toMatchObject({ status: 400, body: { error: 'IAG_DRY_RUN_ACTION_REQUIRED' } });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses stale, tampered, HCI, and INDETERMINATE guides without retry', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    await startBoundTower((input) => refs.service.dryRunBoundToGuide(input));
    const base = { actionPath: refs.actionPath, configPath: refs.configPath };

    const stale = writeGuideFiles({
      guide: { ...guideOf(), digest: 'b'.repeat(64) },
      observed: refs.fixture.action.preState.observed,
    });
    expect(await post('/api/engineer-guide/dry-run', {
      ...base, guidePath: stale.guidePath, observedPath: stale.observedPath,
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'STALE_GUIDE', retry: false, mutationAttempted: false, verifiedSuccess: false },
    });

    const guide = guideOf();
    const files = writeGuideFiles({ guide, observed: refs.fixture.action.preState.observed });
    const proposed = proposeEngineerGuideApply({
      guide,
      storedStepViews: [storedExecutableView],
      stepViews: [],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: refs.fixture.action,
      currentObserved: refs.fixture.action.preState.observed,
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const digestPath = join(root, 'proposal-digest.json');
    writeFileSync(digestPath, JSON.stringify({ ...proposed.proposal, digest: 'c'.repeat(64) }));
    expect(await post('/api/engineer-guide/dry-run', {
      ...base, guidePath: files.guidePath, observedPath: files.observedPath, proposalPath: digestPath,
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'PROPOSAL_TAMPERED', retry: false, mutationAttempted: false },
    });

    writeFileSync(join(root, 'hci-guide.json'), JSON.stringify({ product: 'HCI', guide: guideOf() }));
    writeFileSync(join(root, 'hci-observed.json'), JSON.stringify(refs.fixture.action.preState.observed));
    expect(await post('/api/engineer-guide/dry-run', {
      ...base,
      guidePath: join(root, 'hci-guide.json'),
      observedPath: join(root, 'hci-observed.json'),
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'HCI_GUIDE_APPLY_UNSUPPORTED', retry: false, mutationAttempted: false },
    });

    persistGuideFile(join(root, 'ind-guide.json'));
    writeFileSync(join(root, 'ind-observed.json'), JSON.stringify({
      kind: 'INDETERMINATE', reasonCode: 'READ_BACK_INDETERMINATE',
    }));
    expect(await post('/api/engineer-guide/dry-run', {
      ...base,
      guidePath: join(root, 'ind-guide.json'),
      observedPath: join(root, 'ind-observed.json'),
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'PRESTATE_INDETERMINATE', retry: false, mutationAttempted: false },
    });
    persistGuideFile(join(root, 'unavail-guide.json'));
    writeFileSync(join(root, 'unavail-observed.json'), JSON.stringify({
      kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_UNAVAILABLE',
    }));
    expect(await post('/api/engineer-guide/dry-run', {
      ...base,
      guidePath: join(root, 'unavail-guide.json'),
      observedPath: join(root, 'unavail-observed.json'),
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'PRESTATE_INDETERMINATE', retry: false, mutationAttempted: false },
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses a review_ready guide file that has no stored executable step view', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    await startBoundTower((input) => refs.service.dryRunBoundToGuide(input));
    const guidePath = join(root, 'bare-guide.json');
    const observedPath = join(root, 'bare-observed.json');
    writeFileSync(guidePath, JSON.stringify(guideOf()));
    writeFileSync(observedPath, JSON.stringify(refs.fixture.action.preState.observed));

    expect(await post('/api/engineer-guide/dry-run', {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath, observedPath,
    })).toMatchObject({
      status: 200,
      body: { ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false, verifiedSuccess: false },
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('serves a read-only dashboard form and no guide apply route', async () => {
    await startBoundTower(async () => ({ ok: true }));
    const html = await (await fetch(`${towerUrl}/`)).text();
    expect(html).toContain('가이드 결합 dry-run (읽기 전용)');
    expect(html).toContain('/api/engineer-guide/dry-run');
    expect(html).toContain('runGuideDryRun');
    expect(html).not.toContain('/api/engineer-guide/apply');
    expect(html).not.toContain('sangfor_engineer_guide_apply');
    expect((await post('/api/engineer-guide/apply', {
      actionPath: 'a', configPath: 'c', guidePath: 'g', observedPath: 'o',
    })).status).toBe(404);
  });
});
