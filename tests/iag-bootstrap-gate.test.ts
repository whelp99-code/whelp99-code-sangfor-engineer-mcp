import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTools } from '../apps/mcp-server/src/index.js';
import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import {
  authorizeIagEvidenceBootstrap,
  type IagBootstrapAuthorizationInput,
} from '../packages/sangfor-operator/src/index.js';
import {
  signIagBootstrapApproval,
  type IagBootstrapApproval,
  type IagBootstrapApprovalFields,
} from '../packages/sangfor-operator/src/iag-evidence-bootstrap.js';
import { consumeApprovalNonce } from '../packages/sangfor-operator/src/nonce-store.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
  type AuthorityFixture,
} from './helpers/write-authorization-authority-fixture.js';

process.env.MCP_NO_SERVE = '1';
const SECRET = 'iag-bootstrap-secret-at-least-32-bytes';
let root = '';
let fixture: AuthorityFixture;
let nonceIndex = 0;

function input(overrides: Partial<IagBootstrapAuthorizationInput> = {}): IagBootstrapAuthorizationInput & { readonly approval: IagBootstrapApproval } {
  const action = { ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab' };
  const fields: IagBootstrapApprovalFields = {
    approvedBy: 'operator-1', changeTicketId: 'CHG-O1', rollbackPlanId: 'RB-O1',
    purpose: 'evidence_bootstrap', nonce: `bootstrap-${nonceIndex += 1}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),

  authorityEpoch: 0,};
  const approval = { ...fields, approvalToken: signIagBootstrapApproval(SECRET, action, fields) };
  return {
    action,
    authority: fixture.refs,
    ...overrides,
    approval,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-bootstrap-'));
  fixture = await writeAuthorityFixture({
    root, product: 'IAG', capabilityId: 'internet_policy',
    toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true,
  });
  configureAuthorityEnvironment(root);
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
  process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET = SECRET;
});

afterEach(() => {
  for (const key of [
    'SANGFOR_NONCE_STORE_PATH', 'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_COMPETENCY_ROOT',
    'SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET', 'SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe('O1 IAG candidate bootstrap authorization', () => {
  it('Given exact grounded mock authority and both execution flags, When authorized, Then output is candidate-only', async () => {
    await expect(authorizeIagEvidenceBootstrap(input())).resolves.toEqual({
      kind: 'O1_IAG_CANDIDATE_BOOTSTRAP', promotionEligible: false,
    });
  });

  it.each([
    ['wrong product', { product: 'HCI_SCP' }],
    ['wrong capability', { capabilityId: 'auth_source' }],
    ['broad action', { actionKind: 'policy_bundle' }],
    ['unknown firmware', { firmwareId: '' }],
    ['unknown window', { windowId: '' }],
    ['loopback origin', { originId: 'http://127.0.0.1:3400' }],
  ])('Given %s, When preflight runs, Then it refuses without nonce consumption', async (_name, actionChange) => {
    const base = input();
    const changed = { ...base, action: { ...base.action, ...actionChange } };

    expect(await authorizeIagEvidenceBootstrap(changed)).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(base.approval)).toMatchObject({ ok: true });
  });

  it('Given wrong approval purpose, When preflight runs, Then it refuses without nonce consumption', async () => {
    const base = input();
    const changed = { ...base, approval: { ...base.approval, purpose: 'ordinary_execution' } };

    expect(await authorizeIagEvidenceBootstrap(changed)).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(base.approval)).toMatchObject({ ok: true });
  });

  it('Given one approval and 32 concurrent consumers, When authorization races, Then exactly one wins', async () => {
    const request = input();

    const results = await Promise.all(Array.from({ length: 32 }, () => authorizeIagEvidenceBootstrap(request)));

    expect(results.filter(({ kind }) => kind === 'O1_IAG_CANDIDATE_BOOTSTRAP')).toHaveLength(1);
    expect(results.filter(({ kind }) => kind === 'REFUSED')).toHaveLength(31);
  });

  it('Given general MCP and HTTP surfaces, When bootstrap is attempted, Then no route exists and nonce remains reusable', async () => {
    const request = input();
    expect(listTools().some(({ name }) => name.toLowerCase().includes('bootstrap'))).toBe(false);

    const result = await authorizeToolCall({
      name: 'sangfor_iag_evidence_bootstrap', toolListResult: { tools: listTools() },
      enforceWhitelist: false, approval: request.approval, approvalSecret: SECRET,
    });

    expect(result).toMatchObject({ allow: false, status: 403 });
    expect(await consumeApprovalNonce(request.approval)).toMatchObject({ ok: true });
  });
});
