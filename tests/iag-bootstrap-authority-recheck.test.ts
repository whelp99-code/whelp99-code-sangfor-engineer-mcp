import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DerivedAuthorityScope,
  ResolvedWriteAuthority,
  ResolveWriteAuthorityInput,
} from '../packages/sangfor-competency/src/write-authority.js';
import type { IagBootstrapScope } from '../packages/sangfor-safety/src/index.js';
import { digestCanonicalOrigin } from '../packages/shared/src/index.js';

const mocks = vi.hoisted(() => ({
  resolveAuthority: vi.fn<
    (input: ResolveWriteAuthorityInput) => Promise<ResolvedWriteAuthority>
  >(),
}));

vi.mock('../packages/sangfor-competency/src/write-authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/sangfor-competency/src/write-authority.js')>()),
  resolveConfiguredWriteAuthority: mocks.resolveAuthority,
}));

const {
  authorizeIagEvidenceBootstrap,
  signIagBootstrapApproval,
} = await import('../packages/sangfor-operator/src/iag-evidence-bootstrap.js');
const {
  runIagEvidenceBootstrap,
} = await import('../scripts/lib/iag-evidence-bootstrap-runner.js');

const SECRET = 'iag-bootstrap-recheck-secret-32-bytes';
const ORIGIN = 'https://192.0.2.21';
const REFS = {
  manifestPath: '/authority/manifest.json',
  validationContextPath: '/authority/context.json',
  evidenceRoot: '/authority/evidence',
  ledgerPath: '/authority/promotion.jsonl',
} as const;
let root = '';
let nonceIndex = 0;

const scope = (): DerivedAuthorityScope => ({
  product: 'IAG',
  capabilityId: 'internet_policy',
  toolId: 'iag_o1_evidence_campaign',
  targetEnvironment: 'lab',
  deviceId: 'd'.repeat(64),
  originDigest: digestCanonicalOrigin(ORIGIN, 'origin'),
  firmwareId: 'f'.repeat(64),
  firmwareTruth: {
    recordId: 'firmware-iag-lab',
    vendor: 'SANGFOR',
    adapterProduct: 'IAG',
    productVariant: 'M5100',
    versionRaw: '13.0.0',
    versionFamily: '13.0',
    revision: 'R1',
    buildId: 'build-1',
    hotfix: null,
    uiFingerprint: 'a'.repeat(64),
    apiFingerprint: 'b'.repeat(64),
    status: 'verified',
    observedAt: '2026-08-25T12:00:00.000Z',
    specVersion: 'iag-spec-v1',
    specApplicability: 'verified',
    truthDigest: 'f'.repeat(64),
  },
  implementation: {
    recipeDigest: '1'.repeat(64),
    toolDigest: '2'.repeat(64),
    runtimeDigest: '3'.repeat(64),
  },
  windowId: 'w'.repeat(64),
  sessionId: 'session-1',
  campaignId: 'campaign-1',
});

function actionFor(authority: DerivedAuthorityScope): IagBootstrapScope {
  return {
    product: authority.product,
    capabilityId: authority.capabilityId,
    toolId: authority.toolId,
    targetEnvironment: authority.targetEnvironment,
    deviceId: authority.deviceId,
    firmwareId: authority.firmwareId,
    firmwareTruth: authority.firmwareTruth,
    implementation: authority.implementation,
    windowId: authority.windowId,
    sessionId: authority.sessionId,
    originId: ORIGIN,
    campaignId: authority.campaignId,
    actionKind: 'single_url_exception',
  };
}

function approvalFor(action: IagBootstrapScope) {
  const fields = {
    approvedBy: 'operator-recheck',
    changeTicketId: 'CHG-RECHECK',
    rollbackPlanId: 'RB-RECHECK',
    purpose: 'evidence_bootstrap',
    nonce: `recheck-${nonceIndex += 1}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorityEpoch: 0,
  } as const;
  return {
    ...fields,
    approvalToken: signIagBootstrapApproval(SECRET, action, fields),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-bootstrap-recheck-'));
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
  process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET = SECRET;
});

afterEach(() => {
  mocks.resolveAuthority.mockReset();
  for (const key of [
    'SANGFOR_NONCE_STORE_PATH',
    'SANGFOR_ALLOW_REAL_EXECUTION',
    'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe('IAG bootstrap authority recheck mutations', () => {
  it('uses the authority-returned maturity at the final eligibility gate', async () => {
    const authority = scope();
    const action = actionFor(authority);
    mocks.resolveAuthority.mockResolvedValue({
      status: 'bootstrap_candidate',
      scope: authority,
      maturity: 'implemented_local',
    });

    const result = await authorizeIagEvidenceBootstrap({
      action,
      authority: REFS,
      approval: approvalFor(action),
    });

    expect(result).toEqual({
      kind: 'REFUSED',
      code: 'IAG_BOOTSTRAP_TESTED_MOCK_REQUIRED',
      promotionEligible: false,
    });
    expect(existsSync(process.env.SANGFOR_NONCE_STORE_PATH ?? '')).toBe(false);
  });

  it('refuses when implementation authority changes between derivation and final authorization', async () => {
    const first = scope();
    const changed = {
      ...first,
      implementation: { ...first.implementation, toolDigest: '9'.repeat(64) },
    };
    mocks.resolveAuthority
      .mockResolvedValueOnce({ status: 'bootstrap_candidate', scope: first, maturity: 'tested_mock' })
      .mockResolvedValueOnce({ status: 'bootstrap_candidate', scope: changed, maturity: 'tested_mock' });
    let executorCalls = 0;

    const result = await runIagEvidenceBootstrap({
      command: {
        kind: 'run',
        references: REFS,
        originId: ORIGIN,
        actionKind: 'single_url_exception',
      },
      approval: approvalFor(actionFor(first)),
      createExecution: async () => { executorCalls += 1; },
    });

    expect(result).toEqual({
      kind: 'REFUSED',
      code: 'IAG_BOOTSTRAP_AUTHORITY_SCOPE_MISMATCH',
      executorCalls: 0,
    });
    expect(executorCalls).toBe(0);
    expect(existsSync(process.env.SANGFOR_NONCE_STORE_PATH ?? '')).toBe(false);
  });
});
