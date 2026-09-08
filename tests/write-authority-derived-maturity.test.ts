import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfiguredWriteAuthority } from '../packages/sangfor-competency/src/write-authority.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
} from './helpers/write-authorization-authority-fixture.js';

process.env.MCP_NO_SERVE = '1';
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'write-authority-maturity-'));
});

afterEach(() => {
  for (const key of [
    'SANGFOR_COMPETENCY_ROOT',
    'SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET',
    'SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe('resolved write authority carries the ledger-derived effective maturity', () => {
  it('Given a grounded mock campaign with no promotion, When bootstrap authority resolves, Then it vouches for tested_mock', async () => {
    const fixture = await writeAuthorityFixture({
      root, product: 'IAG', capabilityId: 'internet_policy',
      toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true,
    });
    configureAuthorityEnvironment(root);

    const authority = await resolveConfiguredWriteAuthority({
      references: fixture.refs,
      expected: {
        product: 'IAG', capabilityId: 'internet_policy',
        toolId: 'iag_o1_evidence_campaign', mode: 'bootstrap_mock',
      },
    });

    expect(authority).toMatchObject({ status: 'bootstrap_candidate', maturity: 'tested_mock' });
  });

  it('Given an authenticated promotion above the policy baseline, When ordinary authority resolves, Then it vouches for the promoted field_verified', async () => {
    const fixture = await writeAuthorityFixture({
      root, product: 'HCI_SCP', capabilityId: 'volume_create',
      toolId: 'sangfor_hci_apply_create_volume', fieldVerified: true, mockCampaign: false,
    });
    configureAuthorityEnvironment(root);

    const authority = await resolveConfiguredWriteAuthority({
      references: fixture.refs,
      expected: {
        product: 'HCI_SCP', capabilityId: 'volume_create',
        toolId: 'sangfor_hci_apply_create_volume', mode: 'ordinary_field',
      },
    });

    // The policy baseline on disk is tested_mock; only replaying the authenticated
    // ledger chain yields field_verified. A carried constant cannot satisfy both
    // this case and the bootstrap case above.
    expect(authority).toMatchObject({ status: 'ordinary_active', maturity: 'field_verified' });
  });
});
