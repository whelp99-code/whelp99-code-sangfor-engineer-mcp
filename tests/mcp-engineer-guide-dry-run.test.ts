import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureIagOrchestratorToolService } from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { proposeEngineerGuideApply } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import { writeEngineerGuideApplyFile } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-file.js';
import { evaluateEngineerFieldAcceptance } from '../packages/shared/src/engineer-field-acceptance.js';
import type { EngineerGuide } from '../packages/shared/src/engineer-case-contract.js';
import { computeEngineerGuideDigest } from '../packages/shared/src/engineer-guide-digest.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
  IAG_ORCHESTRATOR_LEDGER_SECRET,
} from './helpers/iag-orchestrator-fixture.js';
import { configureIagMcpFixture } from './helpers/iag-mcp-tool-fixture.js';

process.env.MCP_NO_SERVE = '1';

type McpModule = typeof import('../apps/mcp-server/src/index.js');
let mcp: McpModule;
let root = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-e13-guide-dry-run-'));
  configureIagOrchestratorTestEnvironment(root);
  process.env.SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET = IAG_ORCHESTRATOR_LEDGER_SECRET;
  process.env.SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET = IAG_ORCHESTRATOR_CHECKPOINT_SECRET;
  mcp = await import('../apps/mcp-server/src/index.js');
});

afterEach(() => {
  configureIagOrchestratorToolService(undefined);
  cleanupTestIagMutationAuthorityEnvironment();
  for (const key of [
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
    'SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET', 'SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
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
  readonly root: string;
  readonly guide?: EngineerGuide | {
    readonly product: 'IAG' | 'HCI';
    readonly guide: EngineerGuide;
    readonly stepViews?: readonly StoredStepView[];
  };
  readonly observed: unknown;
}): { readonly guidePath: string; readonly observedPath: string } {
  const guidePath = join(input.root, 'guide.json');
  const observedPath = join(input.root, 'observed.json');
  if (input.guide === undefined) persistGuideFile(guidePath);
  else if ('guide' in input.guide) {
    persistGuideFile(guidePath, input.guide);
  } else persistGuideFile(guidePath, { guide: input.guide });
  writeFileSync(observedPath, JSON.stringify(input.observed));
  return { guidePath, observedPath };
}

function tool(name: string) {
  const handler = mcp.getToolHandler(name);
  if (handler === undefined) throw new TypeError(`MISSING_TOOL:${name}`);
  return handler;
}

describe('guide-bound MCP dry-run (E13 leftover)', () => {
  it('advertises a read-only catalog tool and does not add a mutation apply tool', () => {
    const listed = new Map(mcp.listTools().map((entry) => [entry.name, entry]));
    expect(listed.get('sangfor_engineer_guide_dry_run')?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false,
    });
    expect(listed.get('sangfor_engineer_guide_dry_run')?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['actionPath', 'configPath', 'guidePath', 'observedPath'],
    });
    expect(mcp.getToolHandler('sangfor_engineer_guide_apply')).toBeUndefined();
    expect(mcp.listToolsForProfile('advisor').map((entry) => entry.name))
      .toContain('sangfor_engineer_guide_dry_run');
  });

  it('dry-runs one bound IAG guide step twice without dispatch, verified success, or field_accepted', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true, repeatPreflight: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const files = writeGuideFiles({ root, observed: refs.fixture.action.preState.observed });
    const args = {
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    };

    const first = await tool('sangfor_engineer_guide_dry_run')(args);
    const second = await tool('sangfor_engineer_guide_dry_run')(args);

    for (const result of [first, second]) {
      expect(result).toMatchObject({
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

  it('refuses a stale guide file without retry', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const stale = { ...guideOf(), digest: 'b'.repeat(64) };
    const files = writeGuideFiles({
      root, guide: stale, observed: refs.fixture.action.preState.observed,
    });

    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    })).resolves.toMatchObject({
      ok: false, code: 'STALE_GUIDE', mutationAttempted: false, retry: false, verifiedSuccess: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses an approval envelope on the guide-bound dry-run path', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const files = writeGuideFiles({ root, observed: refs.fixture.action.preState.observed });

    await expect(refs.service.dryRunBoundToGuide({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
      approvalEnvelopePath: refs.approvalEnvelopePath,
    })).rejects.toThrow(/IAG_DRY_RUN_APPROVAL_REFUSED/u);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses a tampered proposal digest and a tampered action digest', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const guide = guideOf();
    const files = writeGuideFiles({ root, guide, observed: refs.fixture.action.preState.observed });
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
    await expect(refs.service.dryRunBoundToGuide({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
      proposalPath: digestPath,
    })).resolves.toMatchObject({
      ok: false, code: 'PROPOSAL_TAMPERED', retry: false, mutationAttempted: false,
    });

    const actionPath = join(root, 'proposal-action.json');
    writeFileSync(actionPath, JSON.stringify({ ...proposed.proposal, actionDigest: 'd'.repeat(64) }));
    await expect(refs.service.dryRunBoundToGuide({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
      proposalPath: actionPath,
    })).resolves.toMatchObject({
      ok: false, code: 'PROPOSAL_TAMPERED', retry: false, mutationAttempted: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses live apply and dryRun:false without dispatch', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false });
    const files = writeGuideFiles({ root, observed: refs.fixture.action.preState.observed });

    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    })).rejects.toThrow(/IAG_DRY_RUN_ACTION_REQUIRED/u);
    expect(mcp.getToolHandler('sangfor_engineer_guide_apply')).toBeUndefined();
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses an HCI guide as unsupported', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const files = writeGuideFiles({
      root,
      guide: { product: 'HCI', guide: guideOf() },
      observed: refs.fixture.action.preState.observed,
    });

    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    })).resolves.toMatchObject({
      ok: false, code: 'HCI_GUIDE_APPLY_UNSUPPORTED', retry: false, mutationAttempted: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses INDETERMINATE and UNAVAILABLE pre-state without retry', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const indeterminate = writeGuideFiles({
      root,
      observed: { kind: 'INDETERMINATE', reasonCode: 'READ_BACK_INDETERMINATE' },
    });
    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: indeterminate.guidePath, observedPath: indeterminate.observedPath,
    })).resolves.toMatchObject({
      ok: false, code: 'PRESTATE_INDETERMINATE', retry: false, mutationAttempted: false,
    });

    persistGuideFile(join(root, 'unavailable-guide.json'));
    writeFileSync(join(root, 'unavailable-observed.json'), JSON.stringify({
      kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_UNAVAILABLE',
    }));
    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: join(root, 'unavailable-guide.json'),
      observedPath: join(root, 'unavailable-observed.json'),
    })).resolves.toMatchObject({
      ok: false, code: 'PRESTATE_INDETERMINATE', retry: false, mutationAttempted: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses a review_ready guide file that has no stored executable step view', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const guidePath = join(root, 'bare-guide.json');
    const observedPath = join(root, 'bare-observed.json');
    writeFileSync(guidePath, JSON.stringify(guideOf()));
    writeFileSync(observedPath, JSON.stringify(refs.fixture.action.preState.observed));

    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath, observedPath,
    })).resolves.toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false, verifiedSuccess: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('refuses stored blocked step views even if a caller would mark them executable', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const files = writeGuideFiles({
      root,
      guide: {
        product: 'IAG',
        guide: guideOf(),
        stepViews: [{ stepId: 'step-url-exception', executable: false, support: 'blocked' }],
      },
      observed: refs.fixture.action.preState.observed,
    });

    await expect(tool('sangfor_engineer_guide_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      guidePath: files.guidePath, observedPath: files.observedPath,
    })).resolves.toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false,
    });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });
});
