import { createHash } from 'node:crypto';
import {
  assertCanonicalCatalogAuthority,
  type CanonicalWorkAtomCatalog,
} from './loader.js';
import {
  parseCampaignStructure,
  type CapabilityCampaignManifest,
  type CampaignProduct,
} from './campaign-schema.js';
import type { WorkAtom } from './schema.js';

const PRODUCT_ATOM_CODE: Readonly<Record<CampaignProduct, string>> = {
  HCI: 'HCI', IAG: 'IAG', EPP: 'EPP', CC: 'CC',
};

const PRODUCT_PREREQUISITE: Readonly<Record<CampaignProduct, string>> = {
  HCI: 'HCI lab cluster and migration/DR targets are not committed',
  IAG: 'IAG lab appliance and isolated authentication source are not committed',
  EPP: 'Endpoint Secure lab manager and disposable endpoint cohort are not committed',
  CC: 'Cyber Command lab tenant and isolated event sources are not committed',
};

export class CampaignAuthorityError extends Error {
  readonly name = 'CampaignAuthorityError';

  constructor(readonly code: 'campaign_semantic_mismatch') {
    super(`CAPABILITY_CAMPAIGN_AUTHORITY_REFUSED: ${code}`);
  }
}

class CampaignCanonicalizationError extends Error {
  readonly name = 'CampaignCanonicalizationError';
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new CampaignCanonicalizationError('campaign value is not canonicalizable');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function campaignAtoms(
  product: CampaignProduct,
  catalog: CanonicalWorkAtomCatalog,
): readonly WorkAtom[] {
  assertCanonicalCatalogAuthority(catalog);
  const code = PRODUCT_ATOM_CODE[product];
  return catalog.atoms.filter(({ product: atomProduct }) => atomProduct === 'ALL' || atomProduct === code);
}

export function buildCapabilityCampaign(
  product: CampaignProduct,
  catalog: CanonicalWorkAtomCatalog,
): CapabilityCampaignManifest {
  assertCanonicalCatalogAuthority(catalog);
  const relevant = campaignAtoms(product, catalog);
  return parseCampaignStructure({
    version: 1,
    kind: 'capability_campaign_requirements',
    campaignId: `capability-campaign-${product}-v1`,
    product,
    catalog: { catalogHash: catalog.manifest.semanticSha256, atomCount: catalog.manifest.counts.atoms },
    readiness: {
      status: 'BLOCKED',
      prerequisites: [
        PRODUCT_PREREQUISITE[product],
        'Lab readiness review is not recorded',
        'Exact device and firmware identities are not recorded',
        'Execution window and human approval are not recorded',
      ],
    },
    paths: {
      labReadiness: `campaign/${product}/lab-readiness.json`,
      deviceInventory: `campaign/${product}/device-inventory.json`,
      firmwareTruth: `campaign/${product}/firmware-truth.json`,
      executionWindow: `campaign/${product}/execution-window.json`,
      humanApproval: `campaign/${product}/human-approval.json`,
      evidenceRoot: `campaign/${product}/evidence`,
    },
    requirements: relevant.map((atom) => ({
      atomId: atom.id,
      atomSha256: digest(atom),
      product: atom.product,
      phase: atom.phase,
      automatability: atom.automatability,
      maturity: atom.maturity,
      capabilityRef: atom.capabilityRef ?? null,
      toolRef: atom.coveredBy ?? null,
      evidence: {
        required: true,
        o5Required: atom.automatability !== 'human',
        requirementPath: `campaign/${product}/evidence/${atom.id}/requirement.json`,
      },
    })),
  });
}

export function verifyCapabilityCampaign(
  manifest: CapabilityCampaignManifest,
  catalog: CanonicalWorkAtomCatalog,
): CapabilityCampaignManifest {
  assertCanonicalCatalogAuthority(catalog);
  const expected = buildCapabilityCampaign(manifest.product, catalog);
  if (canonical(manifest) !== canonical(expected)) throw new CampaignAuthorityError('campaign_semantic_mismatch');
  return manifest;
}

export function parseCapabilityCampaign(
  value: unknown,
  catalog: CanonicalWorkAtomCatalog,
): CapabilityCampaignManifest {
  assertCanonicalCatalogAuthority(catalog);
  return verifyCapabilityCampaign(parseCampaignStructure(value), catalog);
}
