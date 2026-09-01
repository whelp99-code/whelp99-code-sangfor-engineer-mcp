import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeIagEvidenceBootstrap,
  signIagBootstrapApproval,
  type IagBootstrapApproval,
  type IagBootstrapApprovalFields,
  type IagBootstrapAuthorizationInput,
} from '../packages/sangfor-operator/src/iag-evidence-bootstrap.js';
import { consumeApprovalNonce } from '../packages/sangfor-operator/src/nonce-store.js';
import { resolveConfiguredWriteAuthority } from '../packages/sangfor-competency/src/write-authority.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
  type AuthorityFixture,
} from './helpers/write-authorization-authority-fixture.js';

process.env.MCP_NO_SERVE = '1';
const SECRET = 'iag-bootstrap-secret-at-least-32-bytes';
const ATOM_ID = 'iag-o1-policy';
const TOOL_ID = 'iag_o1_evidence_campaign';
let root = '';
let fixture: AuthorityFixture;
let nonceIndex = 0;

/**
 * Rewrites the fixture competency policy so the ledger-derived effective
 * maturity lands on `implemented_local` rather than the fixture default
 * `tested_mock`. The atom claim and the capability policy move together so the
 * grounding stays internally consistent instead of tripping over-claim rules.
 */
function groundMaturityAtImplementedLocal(): void {
  const competencyRoot = join(root, 'competency');
  writeFileSync(join(competencyRoot, 'work-atoms.json'), JSON.stringify({
    version: 1,
    atoms: [{
      id: ATOM_ID, product: 'IAG', phase: 'deploy', title: 'IAG write authority fixture',
      automatability: 'auto', coveredBy: TOOL_ID, maturity: 'implemented_local', evidence: 'fixture',
      capabilityRef: { product: 'IAG', capabilityId: 'internet_policy' },
    }],
  }));
  writeFileSync(join(competencyRoot, 'capability-maturity.json'), JSON.stringify({
    version: 1,
    entries: [{ product: 'IAG', capabilityId: 'internet_policy', maturity: 'implemented_local', evidence: 'fixture' }],
  }));
}

function bootstrapRequest(): IagBootstrapAuthorizationInput & { readonly approval: IagBootstrapApproval } {
  const action = { ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab' };
  const fields: IagBootstrapApprovalFields = {
    approvedBy: 'operator-1', changeTicketId: 'CHG-O1', rollbackPlanId: 'RB-O1',
    purpose: 'evidence_bootstrap', nonce: `authoritative-maturity-${nonceIndex += 1}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorityEpoch: 0,
  };
  return {
    action,
    authority: fixture.refs,
    approval: { ...fields, approvalToken: signIagBootstrapApproval(SECRET, action, fields) },
  };
}

function resolveBootstrapAuthority(): ReturnType<typeof resolveConfiguredWriteAuthority> {
  return resolveConfiguredWriteAuthority({
    references: fixture.refs,
    persistence: 'read_only',
    expected: { product: 'IAG', capabilityId: 'internet_policy', toolId: TOOL_ID, mode: 'bootstrap_mock' },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-bootstrap-maturity-'));
  fixture = await writeAuthorityFixture({
    root, product: 'IAG', capabilityId: 'internet_policy',
    toolId: TOOL_ID, fieldVerified: false, mockCampaign: true,
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

describe('IAG evidence bootstrap authorization on authoritative maturity', () => {
  it('Given authority grounded at implemented_local, When bootstrap is authorized, Then it refuses the mock candidate before nonce consumption', async () => {
    groundMaturityAtImplementedLocal();
    const base = bootstrapRequest();

    const result = await authorizeIagEvidenceBootstrap(base);

    expect(result).toEqual({
      kind: 'REFUSED', code: 'AUTHORITY_MOCK_CANDIDATE_REQUIRED', promotionEligible: false,
    });
    expect(await consumeApprovalNonce(base.approval)).toMatchObject({ ok: true });
  });

  it('Given a bootstrap authorization that reaches the candidate outcome, When the same authority is resolved, Then the outcome rests on an authority-vouched maturity', async () => {
    const base = bootstrapRequest();

    const result = await authorizeIagEvidenceBootstrap(base);

    // The bootstrap eligibility decision must consume the maturity the authority
    // derived, so the authority has to vouch for it rather than leave the
    // operator to re-declare a literal it cannot verify.
    expect(result).toEqual({ kind: 'O1_IAG_CANDIDATE_BOOTSTRAP', promotionEligible: false });
    expect(await resolveBootstrapAuthority()).toMatchObject({
      status: 'bootstrap_candidate', maturity: 'tested_mock',
    });
  });

  it('Given an authenticated promotion that lifts the ledger above tested_mock, When bootstrap is authorized, Then the derived rung refuses even though the policy baseline still reads tested_mock', async () => {
    const promoted = await writeAuthorityFixture({
      root: mkdtempSync(join(tmpdir(), 'iag-bootstrap-promoted-')),
      product: 'IAG', capabilityId: 'internet_policy',
      toolId: TOOL_ID, fieldVerified: true, mockCampaign: true,
    });
    const base = { ...bootstrapRequest(), authority: promoted.refs };

    const result = await authorizeIagEvidenceBootstrap(base);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(base.approval)).toMatchObject({ ok: true });
  });
});
