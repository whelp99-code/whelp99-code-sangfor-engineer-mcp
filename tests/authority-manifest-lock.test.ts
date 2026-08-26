import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_MANIFEST,
  parseAuthorityManifest,
  verifyAuthorityManifest,
} from '../packages/sangfor-authority/src/migration-manifest.js';
import {
  AUTHORITY_MANIFEST_LOCK_PATH,
  AuthorityManifestLockError,
  loadCanonicalAuthorityManifest,
} from '../packages/sangfor-authority/src/authority-manifest-lock.js';
import { loadRepositoryCensus } from '../packages/sangfor-authority/src/repository-census.js';

const ROOT = join(import.meta.dirname, '..');

describe('canonical authority manifest lock', () => {
  it('authenticates the exact repository manifest identity and lock fields', () => {
    const census = loadRepositoryCensus(ROOT);
    const raw: unknown = JSON.parse(readFileSync(join(ROOT, AUTHORITY_MANIFEST_LOCK_PATH), 'utf8'));

    expect(raw).toMatchObject({
      schemaVersion: 1,
      aggregateIds: [...AUTHORITY_MANIFEST.entries.map((entry) => entry.id)].sort(),
      classCounts: { authoritative: 17, derived: 7, credential_local: 1, curated_seed: 1 },
      repositoryCensusDigest: census.digest,
      sourceOnlyRefs: ['m026-spec-registry:data/specs#curated-seed:v1'],
    });
    expect(verifyAuthorityManifest(AUTHORITY_MANIFEST, census)).toMatchObject({ ok: true });
  });

  it('refuses structurally valid manifests that were not authenticated by the lock', () => {
    const census = loadRepositoryCensus(ROOT);
    const parsed = parseAuthorityManifest(structuredClone(AUTHORITY_MANIFEST));
    expect(verifyAuthorityManifest(parsed, census)).toEqual({ ok: false, issues: ['MANIFEST_NOT_CANONICAL'] });
  });

  it('refuses a canonical census whose semantic digest differs from the lock', () => {
    const foreignCensus = loadRepositoryCensus(join(ROOT, 'tests/fixtures'));
    const result = verifyAuthorityManifest(AUTHORITY_MANIFEST, foreignCensus);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new AuthorityManifestLockError('digest mismatch unexpectedly passed');
    expect(result.issues).toContain('census_digest_mismatch');
  });

  it('refuses a 27th aggregate under the unchanged lock', () => {
    const changed = structuredClone(AUTHORITY_MANIFEST);
    const source = changed.entries[changed.entries.length - 1];
    if (!source) throw new AuthorityManifestLockError('fixture_source_missing');
    changed.entries.push({
      ...source,
      id: 'm027-invented',
      order: 27,
      aggregate: 'invented',
      sources: [{ path: 'data/specs', symbol: 'curated-seed:v2' }],
    });

    expect(() => loadCanonicalAuthorityManifest(changed, join(ROOT, AUTHORITY_MANIFEST_LOCK_PATH)))
      .toThrow(AuthorityManifestLockError);
  });

  it('refuses duplicate source-only ownership', () => {
    const changed = structuredClone(AUTHORITY_MANIFEST);
    const source = changed.entries[changed.entries.length - 1];
    if (!source) throw new AuthorityManifestLockError('fixture_source_missing');
    changed.entries.push({ ...source, id: 'm027-duplicate-seed', order: 27, aggregate: 'duplicate_seed' });

    expect(() => loadCanonicalAuthorityManifest(changed, join(ROOT, AUTHORITY_MANIFEST_LOCK_PATH)))
      .toThrow(AuthorityManifestLockError);
  });
});
