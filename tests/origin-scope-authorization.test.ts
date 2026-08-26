import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalizeUrlOrigin,
  digestCanonicalOrigin,
} from '../packages/shared/src/index.js';
import {
  authorizeHciMutation,
  authorizeIagEvidenceBootstrap,
} from '../packages/sangfor-operator/src/index.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import {
  signIagBootstrapApproval,
  type IagBootstrapApprovalFields,
} from '../packages/sangfor-operator/src/iag-evidence-bootstrap.js';
import { consumeApprovalNonce } from '../packages/sangfor-operator/src/nonce-store.js';
import { capabilityEvidenceManifestSchema } from '../packages/sangfor-competency/src/index.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
} from './helpers/write-authorization-authority-fixture.js';

const OPERATOR_SECRET = 'origin-scope-operator-secret';
const BOOTSTRAP_SECRET = 'origin-scope-bootstrap-secret-32';
let root = '';
let nonceIndex = 0;

function configureSafety(): void {
  const dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'safety'), { recursive: true });
  mkdirSync(join(dataRoot, 'competency'), { recursive: true });
  writeFileSync(join(dataRoot, 'safety/capability-safety.json'), JSON.stringify({
    version: 1, defaultSafetyClass: 'human_only',
    entries: [{ product: 'HCI_SCP', capabilityId: 'volume_create', safetyClass: 'auto_allowed', reason: 'fixture' }],
  }));
  writeFileSync(join(dataRoot, 'competency/capability-maturity.json'), JSON.stringify({
    version: 1,
    entries: [{ product: 'HCI_SCP', capabilityId: 'volume_create', maturity: 'field_verified', evidence: 'fixture' }],
  }));
  process.env.SANGFOR_DATA_ROOT = dataRoot;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'origin-scope-'));
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
  process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = OPERATOR_SECRET;
  process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET = BOOTSTRAP_SECRET;
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
  configureSafety();
});

afterEach(() => {
  for (const key of [
    'SANGFOR_NONCE_STORE_PATH', 'SANGFOR_OPERATOR_APPROVAL_SECRET', 'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET',
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION', 'SANGFOR_COMPETENCY_ROOT',
    'SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET', 'SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET', 'SANGFOR_DATA_ROOT',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe('canonical origin contract', () => {
  it.each([
    ['HTTPS://Example.COM:443/path', 'url', 'https://example.com'],
    ['http://Example.COM:80/identity', 'url', 'http://example.com'],
    ['https://Example.COM:8443', 'origin', 'https://example.com:8443'],
  ] as const)('Given %s in %s mode, When canonicalized, Then host case/default port normalize', (value, mode, expected) => {
    expect(canonicalizeUrlOrigin(value, mode)).toBe(expected);
  });

  it.each([
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'https://user@example.com',
  ])('Given non-origin input %s, When exact origin is required, Then it refuses', (value) => {
    expect(() => canonicalizeUrlOrigin(value, 'origin')).toThrow();
  });

  it('Given normalized-equivalent origins, When digested, Then the privacy-preserving digest is identical', () => {
    expect(digestCanonicalOrigin('HTTPS://Example.COM:443', 'origin'))
      .toBe(digestCanonicalOrigin('https://example.com', 'origin'));
  });
});

describe('authenticated origin exact scope', () => {
  it.each([
    'http://192.0.2.23/openstack/identity/v2.0',
    'https://192.0.2.22/openstack/identity/v2.0',
    'http://192.0.2.22:8080/openstack/identity/v2.0',
  ])('Given HCI authority for http://192.0.2.22 and retarget %s, When approval matches retarget, Then authority refuses before nonce', async (identityBaseUrl) => {
    const fixture = writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    const host = new URL(identityBaseUrl).hostname;
    const action = { type: 'hci.create-volume', target: `${host}:field-volume` } as const;
    const fields = {
      approvedBy: 'operator', changeTicketId: 'CHG-O', rollbackPlanId: 'RB-O',
      nonce: `hci-origin-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signApprovalToken(OPERATOR_SECRET, action, fields) };

    const result = await authorizeHciMutation({
      action: { kind: action.type, target: action.target, identityBaseUrl, capabilityId: 'volume_create' },
      approval, authority: fixture.refs,
    });

    expect(result.kind).toBe('REFUSED');
    expect(consumeApprovalNonce(approval)).toMatchObject({ ok: true });
  });

  it('Given matched HCI authority and a normalized default port URL, When authorized, Then exact scope passes', async () => {
    const fixture = writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    const action = { type: 'hci.create-volume', target: '192.0.2.22:field-volume' } as const;
    const fields = {
      approvedBy: 'operator', changeTicketId: 'CHG-H', rollbackPlanId: 'RB-H',
      nonce: `hci-match-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signApprovalToken(OPERATOR_SECRET, action, fields) };

    const result = await authorizeHciMutation({
      action: { kind: action.type, target: action.target, identityBaseUrl: 'http://192.0.2.22:80/openstack/identity/v2.0', capabilityId: 'volume_create' },
      approval, authority: fixture.refs,
    });

    expect(result.kind).toBe('NORMAL_ACTIVE_EVIDENCE');
  });

  it('Given IAG authority for one origin and a validly re-signed retarget, When authorized, Then authority refuses before nonce', async () => {
    const fixture = writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    const action = { ...fixture.scope, originId: 'https://192.0.2.23', actionKind: 'single_url_exception', targetEnvironment: 'lab' };
    const fields: IagBootstrapApprovalFields = {
      approvedBy: 'operator', changeTicketId: 'CHG-I', rollbackPlanId: 'RB-I', purpose: 'evidence_bootstrap',
      nonce: `iag-origin-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signIagBootstrapApproval(BOOTSTRAP_SECRET, action, fields) };

    const result = await authorizeIagEvidenceBootstrap({ action, approval, authority: fixture.refs });

    expect(result.kind).toBe('REFUSED');
    expect(consumeApprovalNonce(approval)).toMatchObject({ ok: true });
  });

  it('Given matched IAG authority and an equivalent default port origin, When authorized, Then exact scope passes', async () => {
    const fixture = writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    const action = { ...fixture.scope, originId: 'https://192.0.2.21:443', actionKind: 'single_url_exception', targetEnvironment: 'lab' };
    const fields: IagBootstrapApprovalFields = {
      approvedBy: 'operator', changeTicketId: 'CHG-M', rollbackPlanId: 'RB-M', purpose: 'evidence_bootstrap',
      nonce: `iag-match-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signIagBootstrapApproval(BOOTSTRAP_SECRET, action, fields) };

    const result = await authorizeIagEvidenceBootstrap({ action, approval, authority: fixture.refs });

    expect(result.kind).toBe('O1_IAG_CANDIDATE_BOOTSTRAP');
  });

  it('Given approval bound to the original IAG origin, When only the action origin changes, Then it refuses before nonce', async () => {
    const fixture = writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    const original = { ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab' };
    const fields: IagBootstrapApprovalFields = {
      approvedBy: 'operator', changeTicketId: 'CHG-A', rollbackPlanId: 'RB-A', purpose: 'evidence_bootstrap',
      nonce: `iag-altered-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signIagBootstrapApproval(BOOTSTRAP_SECRET, original, fields) };

    const result = await authorizeIagEvidenceBootstrap({
      action: { ...original, originId: 'https://192.0.2.23' }, approval, authority: fixture.refs,
    });

    expect(result.kind).toBe('REFUSED');
    expect(consumeApprovalNonce(approval)).toMatchObject({ ok: true });
  });

  it('Given a legacy live manifest without originDigest, When HCI authorizes, Then no compatibility shim exists and nonce remains reusable', async () => {
    const fixture = writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(fixture.refs.manifestPath, 'utf8')));
    const { originDigest: _originDigest, ...legacyDigests } = manifest.digests;
    writeFileSync(fixture.refs.manifestPath, JSON.stringify({ ...manifest, digests: legacyDigests }));
    const action = { type: 'hci.create-volume', target: '192.0.2.22:legacy-volume' } as const;
    const fields = {
      approvedBy: 'operator', changeTicketId: 'CHG-L', rollbackPlanId: 'RB-L',
      nonce: `hci-legacy-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = { ...fields, approvalToken: signApprovalToken(OPERATOR_SECRET, action, fields) };

    const result = await authorizeHciMutation({
      action: { kind: action.type, target: action.target, identityBaseUrl: 'http://192.0.2.22/openstack/identity/v2.0', capabilityId: 'volume_create' },
      approval, authority: fixture.refs,
    });

    expect(result.kind).toBe('REFUSED');
    expect(consumeApprovalNonce(approval)).toMatchObject({ ok: true });
  });
});
