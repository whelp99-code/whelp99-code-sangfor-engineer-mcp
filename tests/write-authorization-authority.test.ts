import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeHciMutation,
  authorizeIagEvidenceBootstrap,
} from '../packages/sangfor-operator/src/index.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { signIagBootstrapApproval } from '../packages/sangfor-operator/src/iag-evidence-bootstrap.js';
import { consumeApprovalNonce } from '../packages/sangfor-operator/src/nonce-store.js';
import {
  capabilityEvidenceManifestSchema,
  maturityPolicyFileSchema,
} from '../packages/sangfor-competency/src/index.js';
import { evidenceValidationContextSchema } from '../packages/sangfor-competency/src/evidence-validation-context.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
  type AuthorityFixture,
} from './helpers/write-authorization-authority-fixture.js';

const OPERATOR_SECRET = 'write-authority-operator-secret';
const BOOTSTRAP_SECRET = 'write-authority-bootstrap-secret-32';
let root = '';
let nonceIndex = 0;

function configureSafety(): void {
  const dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'safety'), { recursive: true });
  mkdirSync(join(dataRoot, 'competency'), { recursive: true });
  writeFileSync(join(dataRoot, 'safety/capability-safety.json'), JSON.stringify({
    version: 1,
    defaultSafetyClass: 'human_only',
    entries: [{ product: 'HCI_SCP', capabilityId: 'volume_create', safetyClass: 'auto_allowed', reason: 'fixture' }],
  }));
  writeFileSync(join(dataRoot, 'competency/capability-maturity.json'), JSON.stringify({
    version: 1,
    entries: [{ product: 'HCI_SCP', capabilityId: 'volume_create', maturity: 'field_verified', evidence: 'fixture' }],
  }));
  process.env.SANGFOR_DATA_ROOT = dataRoot;
}

function approval(action: { readonly type: string; readonly target: string }) {
  const fields = {
    approvedBy: 'operator-1', changeTicketId: 'CHG-11', rollbackPlanId: 'RB-11',
    nonce: `authority-${nonceIndex += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),

  authorityEpoch: 0,};
  return { ...fields, approvalToken: signApprovalToken(OPERATOR_SECRET, action, fields) };
}

function bootstrapApproval(fixture: AuthorityFixture) {
  const fields = {
    approvedBy: 'operator-1', changeTicketId: 'CHG-O1', rollbackPlanId: 'RB-O1',
    purpose: 'evidence_bootstrap', nonce: `bootstrap-${nonceIndex += 1}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),

  authorityEpoch: 0,};
  return { ...fields, approvalToken: signIagBootstrapApproval(BOOTSTRAP_SECRET, {
    ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab',
  }, fields) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'write-authority-'));
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
  process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = OPERATOR_SECRET;
  process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET = BOOTSTRAP_SECRET;
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

const flagCases = [
  ['neither', false, false],
  ['real only', true, false],
  ['production only', false, true],
  ['both', true, true],
] as const;

async function hciAttempt(fixture: AuthorityFixture) {
  const action = { type: 'hci.create-volume', target: '192.0.2.22:field-volume' } as const;
  const signed = approval(action);
  const result = await authorizeHciMutation({
    action: { kind: action.type, target: action.target, identityBaseUrl: 'http://192.0.2.22/openstack/identity/v2.0', capabilityId: 'volume_create' },
    approval: signed,
    authority: fixture.refs,
  });
  return { result, signed };
}

function inputForProductionLabel(fixture: AuthorityFixture) {
  const signed = bootstrapApproval(fixture);
  return {
    action: { ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab', production: false },
    approval: signed,
    authority: fixture.refs,
  } as const;
}

async function bootstrapAttempt(fixture: AuthorityFixture) {
  const signed = bootstrapApproval(fixture);
  const result = await authorizeIagEvidenceBootstrap({
    action: { ...fixture.scope, actionKind: 'single_url_exception', targetEnvironment: 'lab' },
    approval: signed,
    authority: fixture.refs,
  });
  return { result, signed };
}

describe('non-loopback double execution flag gate', () => {
  it.each(flagCases)('Given %s flags for HCI, When authority is valid, Then only both flags authorize', async (_name, real, production) => {
    const fixture = await writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    if (real) process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    if (production) process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';

    const { result, signed } = await hciAttempt(fixture);

    expect(result.kind).toBe(real && production ? 'NORMAL_ACTIVE_EVIDENCE' : 'REFUSED');
    if (!(real && production)) expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it.each(flagCases)('Given %s flags for bootstrap, When the candidate is valid, Then only both flags authorize', async (_name, real, production) => {
    const fixture = await writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    if (real) process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    if (production) process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';

    const { result, signed } = await bootstrapAttempt(fixture);

    expect(result.kind).toBe(real && production ? 'O1_IAG_CANDIDATE_BOOTSTRAP' : 'REFUSED');
    if (!(real && production)) expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });
});

describe('internally derived write authority', () => {
  it('Given valid authenticated field authority, When HCI authorizes, Then the dispatch seam is reached exactly once', async () => {
    const fixture = await writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    let dispatchCount = 0;

    const { result } = await hciAttempt(fixture);
    if (result.kind === 'NORMAL_ACTIVE_EVIDENCE') dispatchCount += 1;

    expect(result.kind).toBe('NORMAL_ACTIVE_EVIDENCE');
    expect(dispatchCount).toBe(1);
  });

  it('Given caller production=false on a remote bootstrap action, When only the real flag is set, Then the label cannot bypass the second flag', async () => {
    const fixture = await writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    const base = inputForProductionLabel(fixture);

    const result = await authorizeIagEvidenceBootstrap(base);

    expect(result.kind).toBe('REFUSED');
    expect(await consumeApprovalNonce(base.approval)).toMatchObject({ ok: true });
  });

  it('Given caller-forged field evidence and policy without an authenticated promotion, When HCI authorizes, Then it refuses before nonce', async () => {
    const fixture = await writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: false, mockCampaign: false });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    const policyPath = join(root, 'competency/capability-maturity.json');
    const policy = maturityPolicyFileSchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
    writeFileSync(policyPath, JSON.stringify({
      ...policy,
      entries: policy.entries.map((entry) => ({ ...entry, maturity: 'field_verified' })),
    }));

    const { result, signed } = await hciAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it.each(['manifest', 'context', 'ledger', 'checkpoint'] as const)('Given corrupt %s authority, When HCI authorizes, Then it refuses before nonce', async (part) => {
    const fixture = await writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    const path = part === 'manifest' ? fixture.refs.manifestPath
      : part === 'context' ? fixture.refs.validationContextPath
        : part === 'ledger' ? fixture.refs.ledgerPath : `${fixture.refs.ledgerPath}.head.json`;
    writeFileSync(path, '{corrupt');

    const { result, signed } = await hciAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it.each(['missing_ledger_secret', 'missing_checkpoint_secret', 'secret_domain_collision'] as const)('Given %s, When HCI authorizes, Then it refuses before nonce', async (part) => {
    const fixture = await writeAuthorityFixture({ root, product: 'HCI_SCP', capabilityId: 'volume_create', toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    if (part === 'missing_ledger_secret') delete process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET;
    if (part === 'missing_checkpoint_secret') delete process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET;
    if (part === 'secret_domain_collision') {
      process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET = OPERATOR_SECRET;
    }

    const { result, signed } = await hciAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it.each(['artifact', 'stale_context', 'real_device_mock'] as const)('Given forged %s evidence, When bootstrap authorizes, Then it refuses before nonce', async (part) => {
    const fixture = await writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    if (part === 'artifact') {
      const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(fixture.refs.manifestPath, 'utf8')));
      const artifact = manifest.artifacts[0];
      if (artifact !== undefined) writeFileSync(join(fixture.refs.evidenceRoot, artifact.path), 'forged');
    } else {
      const context = evidenceValidationContextSchema.parse(JSON.parse(readFileSync(fixture.refs.validationContextPath, 'utf8')));
      writeFileSync(fixture.refs.validationContextPath, JSON.stringify({
        ...context,
        ...(part === 'stale_context' ? { evaluatedAt: '2027-08-25T12:00:00.000Z' } : {}),
        ...(part === 'real_device_mock' ? {
          runIdentities: context.runIdentities.map((identity) => ({ ...identity, environment: 'real_device' })),
        } : {}),
      }));
    }

    const { result, signed } = await bootstrapAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it('Given active field promotion already exists, When bootstrap authorizes, Then it refuses before nonce', async () => {
    const fixture = await writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: true, mockCampaign: true });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';

    const { result, signed } = await bootstrapAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });

  it('Given a forged completed mock boolean is impossible to pass, When candidate negatives are incomplete, Then bootstrap refuses before nonce', async () => {
    const fixture = await writeAuthorityFixture({ root, product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true });
    configureAuthorityEnvironment(root);
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(fixture.refs.manifestPath, 'utf8')));
    writeFileSync(fixture.refs.manifestPath, JSON.stringify({
      ...manifest,
      negativeCases: manifest.negativeCases.slice(0, 4),
      o5Counters: { ...manifest.o5Counters, negativeCasePassCount: 4 },
    }));

    const { result, signed } = await bootstrapAttempt(fixture);

    expect(result).toMatchObject({ kind: 'REFUSED' });
    expect(await consumeApprovalNonce(signed)).toMatchObject({ ok: true });
  });
});
