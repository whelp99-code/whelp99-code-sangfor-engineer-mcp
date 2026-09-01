import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../packages/sangfor-learning-strategy/src/', import.meta.url));
const PURE_LOC_CEILING = 250;

/**
 * Mirrors the reviewer's measurement:
 *   awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(\/\/|#|--)/' <file> | wc -l
 */
function pureLoc(source: string): number {
  return source.split('\n').filter((line) => line.trim().length > 0 && !/^\s*(\/\/|#|--)/u.test(line)).length;
}

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative(SRC, full)] : [];
  }).sort();
}

/**
 * Each focused module owns one responsibility and is the single home of the
 * operations named here. The facade may re-export but must not re-implement.
 */
const MODULE_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  'registry-contracts.ts': ['ProductRegistryError', 'normalizeRegistryAlias', 'normalizeRegistryCode'],
  'registry-validation.ts': ['computeProductRegistryDigest', 'createProductRegistryView', 'validateProductRegistryView'],
  'registry-resolution.ts': ['resolveInjectedProductIdentity', 'resolveInjectedAdapterProductCode'],
  'lr01-research.ts': ['validateLR01Recipe', 'LR01ResearchFacade'],
  'lr02-benchmark.ts': ['validateLR02Recipe', 'LR02BenchmarkFacade'],
  'lr03-probe.ts': ['validateLR03Recipe', 'LR03ProbeFacade'],
  'lr04-benchmark.ts': ['LR04BenchmarkFacade'],
  'stale-candidate.ts': ['createStaleCandidate', 'confirmStaleCandidate'],
  'lm06-stream.ts': ['validateLM06Recipe', 'LM06StreamFacade'],
  'input-guard.ts': ['assertSafeLearningInput'],
  'strategy-store-access.ts': [
    'allStrategyRevisions', 'loadStrategyStores', 'openStrategyStore',
    'strategyStoreManager', 'strategyStorePath', 'uniqueRevisions',
  ],
  'strategy-listing.ts': ['decodeStrategyCursor', 'listStrategyRevisions'],
  'strategy-authoring.ts': ['researchStrategy'],
  'strategy-transition.ts': ['promoteStrategyRevision', 'toValidationRequest', 'validateStrategyRevision'],
  'strategy-facts.ts': ['assertFactQueryRequest', 'collectStrategyFacts'],
  'service.ts': ['LearningStrategyService'],
};

/** Type-only module of the split; carries no runtime export to census. */
const CONTRACTS_MODULE = 'service-contracts.ts';


/** The runtime surface `index.ts` republishes through `export * from './service.js'`. */
const FACADE_RUNTIME_EXPORTS = ['LearningStrategyService', 'assertSafeLearningInput'];

async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  return await import(join(SRC, specifier)) as Record<string, unknown>;
}

describe('learning-strategy module census', () => {
  it('keeps every module of the service split inside the reviewable size ceiling', () => {
    // Given: the modules the split produced.
    const owned = [...Object.keys(MODULE_OWNERSHIP), CONTRACTS_MODULE];
    // When: each is measured in pure (non-blank, non-comment) lines.
    const oversized = owned
      .filter((name) => new Set(sourceFiles()).has(name))
      .map((name) => ({ name, pureLoc: pureLoc(readFileSync(join(SRC, name), 'utf8')) }))
      .filter((entry) => entry.pureLoc > PURE_LOC_CEILING);
    // Then: none has outgrown a single reviewer's working memory.
    expect(oversized).toEqual([]);
  });

  it('adds no new oversized file to the package', () => {
    // Given: the whole shipped source tree.
    const files = sourceFiles();
    // When: every file is measured against the ceiling.
    const oversized = files
      .filter((name) => pureLoc(readFileSync(join(SRC, name), 'utf8')) > PURE_LOC_CEILING)
      .sort();
    // Then: the package carries no ratcheted exception.
    expect(files.length).toBeGreaterThan(0);
    expect(oversized).toEqual([]);
  });

  it('gives every split operation exactly one owning module', async () => {
    // Given: the declared ownership map.
    const present = new Set(sourceFiles());
    // When: each owning module is loaded and its runtime exports inspected.
    const missing: string[] = [];
    for (const [specifier, owned] of Object.entries(MODULE_OWNERSHIP)) {
      if (!present.has(specifier)) {
        missing.push(`${specifier} (module absent)`);
        continue;
      }
      const loaded = await loadModule(specifier);
      for (const name of owned) {
        if (typeof loaded[name] !== 'function') missing.push(`${specifier}#${name}`);
      }
    }
    // Then: every named operation resolves to a callable in its declared home.
    expect(missing).toEqual([]);
  });

  it('exposes exactly the pre-split runtime export surface from the facade', async () => {
    // Given: the facade module the package index re-exports.
    const facade = await loadModule('service.ts');
    // When: its runtime export names are enumerated.
    const names = Object.keys(facade).sort();
    // Then: the public surface is unchanged by the split.
    expect(names).toEqual([...FACADE_RUNTIME_EXPORTS].sort());
  });

  it('re-exports split runtime values by identity so compatibility facades cannot drift', async () => {
    // Given: each compatibility facade and the modules that own its runtime values.
    const facades: Readonly<Record<string, string>> = {
      'registry-contracts.ts': 'contracts.ts',
      'registry-validation.ts': 'contracts.ts',
      'registry-resolution.ts': 'contracts.ts',
      'lr01-research.ts': 'lr-research.ts',
      'lr02-benchmark.ts': 'lr-research.ts',
      'lr03-probe.ts': 'lr-research.ts',
      'lr04-benchmark.ts': 'lr-research.ts',
      'stale-candidate.ts': 'lr-research.ts',
      'lm06-stream.ts': 'lm05-import.ts',
      'input-guard.ts': 'service.ts',
    };
    // When: every owned runtime export is compared across both entry points.
    const drifted: string[] = [];
    for (const [ownerName, facadeName] of Object.entries(facades)) {
      const [owner, facade] = await Promise.all([loadModule(ownerName), loadModule(facadeName)]);
      for (const exportName of MODULE_OWNERSHIP[ownerName] ?? []) {
        if (facade[exportName] !== owner[exportName]) drifted.push(`${facadeName}#${exportName}`);
      }
    }
    // Then: every facade exposes the owning value itself, not a copied implementation.
    expect(drifted).toEqual([]);
  });

  it('routes facade operations through the owning modules instead of a local copy', async () => {
    // Given: the facade class.
    const facade = await loadModule('service.ts');
    const service = facade.LearningStrategyService as { prototype: Record<string, unknown> };
    // When: the shipped method bodies are read back.
    const bodies = ['list', 'research', 'validate', 'promote', 'collectFacts']
      .map((name) => ({ name, body: String(service.prototype[name]) }));
    // Then: none of them still enumerates or opens stores inside the facade.
    expect(bodies.filter(({ body }) => /readdirSync|StrategyStoreManager/u.test(body)).map(({ name }) => name)).toEqual([]);
  });
});
