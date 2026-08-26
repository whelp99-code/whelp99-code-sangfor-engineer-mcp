import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CampaignAuthorityError,
  CatalogAuthorityError,
  CensusAuthorityError,
  assertCanonicalCatalogAuthority,
  buildCapabilityCampaign,
  buildProductEvidenceCensus,
  buildRepoCoverageContext,
  deriveWorkAtomCatalogManifest,
  loadCanonicalWorkAtomCatalog,
  parseCapabilityCampaign,
  parseProductEvidenceCensus,
} from '../packages/sangfor-competency/src/index.js';

function authority() {
  const loaded = loadCanonicalWorkAtomCatalog();
  if (!loaded.ok) throw new Error('canonical catalog unavailable');
  const coverage = buildRepoCoverageContext(['sangfor_evaluate_config']);
  if (!coverage.ok) throw new Error('coverage fixture unavailable');
  return { catalog: loaded.catalog, coverage: coverage.context };
}

describe('canonical catalog runtime authority', () => {
  it('Given an exact verified loader result, When asserted and consumed, Then its identity passes and its complete graph is frozen', () => {
    const value = authority();

    expect(() => assertCanonicalCatalogAuthority(value.catalog)).not.toThrow();
    expect(buildCapabilityCampaign('HCI', value.catalog).product).toBe('HCI');
    expect(buildProductEvidenceCensus(value.catalog, value.coverage).totals.atoms).toBe(20);
    expect(Object.isFrozen(value.catalog)).toBe(true);
    expect(Object.isFrozen(value.catalog.atoms)).toBe(true);
    expect(value.catalog.atoms.every((atom) => Object.isFrozen(atom)
      && (atom.capabilityRef === undefined || Object.isFrozen(atom.capabilityRef)))).toBe(true);
    expect(Object.isFrozen(value.catalog.manifest)).toBe(true);
    expect(Object.isFrozen(value.catalog.manifest.atomIds)).toBe(true);
    expect(Object.isFrozen(value.catalog.manifest.counts)).toBe(true);
    const first = value.catalog.atoms[0];
    if (first === undefined) throw new Error('catalog atom unavailable');
    expect(Reflect.set(first, 'title', 'mutation attempt')).toBe(false);
    expect(() => buildCapabilityCampaign('HCI', value.catalog)).not.toThrow();
  });

  it('Given plain, cloned, wrapped, copied-symbol, or derived lookalikes, When every public authority path runs, Then each refuses the runtime identity', () => {
    const value = authority();
    const campaign = buildCapabilityCampaign('HCI', value.catalog);
    const census = buildProductEvidenceCensus(value.catalog, value.coverage);
    const copied: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(value.catalog)) Reflect.set(copied, key, Reflect.get(value.catalog, key));
    const lookalikes: readonly object[] = [
      { atoms: value.catalog.atoms, manifest: value.catalog.manifest },
      { ...value.catalog },
      Object.create(value.catalog),
      copied,
      { atoms: value.catalog.atoms, manifest: deriveWorkAtomCatalogManifest(value.catalog.atoms) },
    ];

    for (const catalog of lookalikes) {
      const calls = [
        () => assertCanonicalCatalogAuthority(catalog),
        () => Reflect.apply(buildCapabilityCampaign, undefined, ['HCI', catalog]),
        () => Reflect.apply(parseCapabilityCampaign, undefined, [campaign, catalog]),
        () => Reflect.apply(buildProductEvidenceCensus, undefined, [catalog, value.coverage]),
        () => Reflect.apply(parseProductEvidenceCensus, undefined, [census, { catalog, context: value.coverage }]),
      ];
      for (const call of calls) {
        expect(call).toThrow(CatalogAuthorityError);
        try { call(); } catch (error) {
          if (!(error instanceof CatalogAuthorityError)) throw error;
          expect(error.code).toBe('catalog_authority_invalid');
        }
      }
    }
  });
});

describe('campaign semantic authority', () => {
  it('Given a missing requirement with self-consistent structural fields, When authority parses it, Then it refuses', () => {
    const value = authority();
    const campaign = buildCapabilityCampaign('HCI', value.catalog);
    const forged = { ...campaign, requirements: campaign.requirements.slice(1) };

    expect(() => parseCapabilityCampaign(forged, value.catalog)).toThrow(CampaignAuthorityError);
  });

  it('Given campaignId rebound to another valid product, When authority parses it, Then it refuses', () => {
    const value = authority();
    const campaign = buildCapabilityCampaign('HCI', value.catalog);

    expect(() => parseCapabilityCampaign({ ...campaign, product: 'CC' }, value.catalog)).toThrow(CampaignAuthorityError);
  });

  it('Given a forged but well-shaped atom hash, When authority parses it, Then it refuses', () => {
    const value = authority();
    const campaign = buildCapabilityCampaign('HCI', value.catalog);
    const first = campaign.requirements[0];
    if (first === undefined) throw new Error('campaign fixture unavailable');
    const requirements = [{ ...first, atomSha256: 'f'.repeat(64) }, ...campaign.requirements.slice(1)];

    expect(() => parseCapabilityCampaign({ ...campaign, requirements }, value.catalog)).toThrow(CampaignAuthorityError);
  });

  it('Given a CC-only semantic change, When HCI is generated, Then its full catalog hash also changes', () => {
    const value = authority();
    const original = buildCapabilityCampaign('HCI', value.catalog);
    const changedAtoms = value.catalog.atoms.map((atom) =>
      atom.product === 'CC' ? { ...atom, title: `${atom.title} changed` } : atom);
    const root = mkdtempSync(join(tmpdir(), 'cross-product-catalog-'));
    try {
      writeFileSync(join(root, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: changedAtoms }));
      writeFileSync(join(root, 'catalog-manifest.json'), JSON.stringify(deriveWorkAtomCatalogManifest(changedAtoms)));
      const loaded = loadCanonicalWorkAtomCatalog(root);
      if (!loaded.ok) throw new Error('changed canonical catalog unavailable');
      const changed = buildCapabilityCampaign('HCI', loaded.catalog);

      expect(changed.catalog.catalogHash).not.toBe(original.catalog.catalogHash);
      expect(changed.requirements).toEqual(original.requirements);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('census semantic authority', () => {
  it('Given invented 20/0 totals and a reclassified projection, When authority parses it, Then it refuses', () => {
    const value = authority();
    const census = buildProductEvidenceCensus(value.catalog, value.coverage);
    const first = census.atoms[0];
    if (first === undefined) throw new Error('census fixture unavailable');
    const atoms = [{ ...first, product: 'INVENTED', phase: 'operate', automatability: 'auto', toolRef: 'invented_tool' }, ...census.atoms.slice(1)];
    const misleading = { ...census, totals: { atoms: 20, automatable: 20, humanOnly: 0 }, atoms };

    expect(() => parseProductEvidenceCensus(misleading, {
      catalog: value.catalog,
      context: value.coverage,
    })).toThrow(CensusAuthorityError);
  });
});
