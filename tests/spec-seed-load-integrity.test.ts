/**
 * Every curated spec seed on disk must load as real, citable spec items.
 *
 * The loader turns an unparseable file into a `_load_error` MUST sentinel so a
 * corrupt seed can never produce a false clean bill of health. That sentinel is
 * a last resort: a seed file that ships in the repo must never trip it, because
 * a sentinel replaces every real item in that file with one INDETERMINATE
 * placeholder — the advisory loses the whole baseline it was meant to check.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSpecCoverage, loadSpec } from '../packages/sangfor-spec/src/index.js';

const SPEC_ROOT = join(import.meta.dirname, '..', 'data', 'specs');
const SENTINEL_CAPABILITY = '_load_error';

interface OnDiskItem {
  file: string;
  id: string;
  /** Manual text as written on disk, under whichever citation field the file uses. */
  manual?: string;
}

interface OnDiskSeed {
  product: string;
  version: string;
  items: OnDiskItem[];
}

function readOnDiskSeeds(): OnDiskSeed[] {
  const seeds: OnDiskSeed[] = [];
  for (const product of readdirSync(SPEC_ROOT, { withFileTypes: true })) {
    if (!product.isDirectory()) continue;
    const productDir = join(SPEC_ROOT, product.name);
    for (const version of readdirSync(productDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const versionDir = join(productDir, version.name);
      const items: OnDiskItem[] = [];
      for (const file of readdirSync(versionDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json') || file.name.startsWith('.')) continue;
        const raw = JSON.parse(readFileSync(join(versionDir, file.name), 'utf8')) as {
          items?: Array<{ id?: unknown; source?: { manual?: unknown }; citation?: { manual?: unknown } }>;
        };
        for (const item of raw.items ?? []) {
          const manual = item.source?.manual ?? item.citation?.manual;
          items.push({
            file: file.name,
            id: String(item.id),
            manual: typeof manual === 'string' ? manual : undefined,
          });
        }
      }
      if (items.length > 0) seeds.push({ product: product.name, version: version.name, items });
    }
  }
  return seeds;
}

const seeds = readOnDiskSeeds();
const onDiskItemTotal = seeds.reduce((sum, seed) => sum + seed.items.length, 0);
const cases = seeds.map((seed) => [`${seed.product}/${seed.version}`, seed] as const);

describe('curated spec seeds load without load-error sentinels', () => {
  it('Given the spec tree, When enumerated, Then every product/version with items is under test', () => {
    // Given / When
    const covered = seeds.map((seed) => `${seed.product}/${seed.version}`).sort();

    // Then
    expect(covered).toEqual([
      'CC/3.0.98',
      'CISCO_IOSXE/17.0.0',
      'EPP/6.0.4',
      'FORTIOS/8.0.0',
      'HCI/6.11.3',
      'IAG/13.0.120',
      'NGFW/8.0.107',
      'XDR/3.0.98',
    ]);
    expect(onDiskItemTotal).toBe(45);
  });

  it.each(cases)('Given the %s seed, When loaded, Then every on-disk item survives with no sentinel', (_label, seed) => {
    // Given / When
    const loaded = loadSpec(seed.product, seed.version, SPEC_ROOT);

    // Then
    expect(loaded).not.toBeNull();
    const sentinels = loaded!.items.filter((item) => item.capabilityId === SENTINEL_CAPABILITY);
    expect(sentinels.map((item) => item.label)).toEqual([]);
    expect(loaded!.items.map((item) => item.id).sort()).toEqual(seed.items.map((item) => item.id).sort());
  });

  it.each(cases)('Given the %s seed, When loaded, Then citations and op/severity survive', (_label, seed) => {
    // Given
    const loaded = loadSpec(seed.product, seed.version, SPEC_ROOT);
    const byId = new Map(loaded!.items.map((item) => [item.id, item]));

    // When
    const lostCitations = seed.items
      .filter((item) => item.manual !== undefined && byId.get(item.id)?.source?.manual !== item.manual)
      .map((item) => `${item.file}#${item.id}`);
    const missingSemantics = loaded!.items
      .filter((item) => item.op === undefined || item.severity === undefined)
      .map((item) => item.id);

    // Then
    expect(lostCitations).toEqual([]);
    expect(missingSemantics).toEqual([]);
  });

  it('Given the default spec root, When coverage is listed, Then all 45 items load with no sentinel', () => {
    // Given / When
    const coverage = listSpecCoverage();
    const totalItems = coverage.reduce((sum, entry) => sum + entry.items, 0);
    const sentinelBearing = coverage.filter((entry) => {
      const spec = loadSpec(entry.product, entry.version);
      return spec?.items.some((item) => item.capabilityId === SENTINEL_CAPABILITY) ?? false;
    });

    // Then
    expect(sentinelBearing).toEqual([]);
    expect(totalItems).toBe(45);
  });
});
