import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHORITY_MANIFEST,
  AuthorityManifestError,
  parseAuthorityManifest,
  verifyAuthorityManifest,
} from '../packages/sangfor-authority/src/migration-manifest.js';
import { loadRepositoryCensus } from '../packages/sangfor-authority/src/repository-census.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(source = "import { appendFileSync } from 'node:fs'; export function save() { appendFileSync('ledger', 'x'); }"): string {
  const root = mkdtempSync(join(tmpdir(), 'authority-manifest-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/example/src'), { recursive: true });
  mkdirSync(join(root, 'prisma/migrations/fixture'), { recursive: true });
  writeFileSync(join(root, 'packages/example/package.json'), JSON.stringify({ name: '@sangfor/example' }));
  writeFileSync(join(root, 'packages/example/src/store.ts'), source);
  writeFileSync(join(root, 'prisma/schema.prisma'), 'model Example {\n id String @id\n projectId String\n}\n');
  writeFileSync(join(root, 'prisma/migrations/fixture/migration.sql'), [
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL);',
    'ALTER TABLE "Example" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "Example" FORCE ROW LEVEL SECURITY;',
    'CREATE POLICY "Example_scope" ON "Example" USING ("projectId" = current_setting(\'app.project_id\', true)) WITH CHECK ("projectId" = current_setting(\'app.project_id\', true));',
  ].join('\n'));
  return root;
}

function rawManifest(reference = 'persist:packages/example/src/store.ts#save') {
  const sourceMatch = /^(?:persist|credential):(.+)#([^#]+)$/u.exec(reference);
  return {
    version: 1,
    entries: [{
      id: 'm001-example', order: 1, aggregate: 'example', ownerPackage: '@sangfor/example',
      classification: 'authoritative',
      sources: [
        { path: 'prisma/schema.prisma', symbol: 'Example' },
        { path: sourceMatch?.[1] ?? 'packages/example/src/store.ts', symbol: sourceMatch?.[2] ?? 'save' },
      ],
      target: { kind: 'postgres', tables: ['Example'] },
      projectScope: 'required', rlsRequired: true, secretPolicy: 'none',
      prerequisites: [], dependsOn: [], inventoryRefs: ['prisma:model:Example', reference],
    }],
  };
}

describe('canonical authority manifest verification', () => {
  it('keeps strict parsed manifests unauthenticated until a repository lock accepts them', () => {
    const root = repository();
    const census = loadRepositoryCensus(root);
    const manifest = parseAuthorityManifest(rawManifest());

    const result = verifyAuthorityManifest(manifest, census);

    expect(result).toEqual({ ok: false, issues: ['MANIFEST_NOT_CANONICAL'] });
    expect(Object.isFrozen(census)).toBe(true);
    expect(Object.isFrozen(census.references)).toBe(true);
  });

  it.each([
    ['plain census', (manifest: unknown, census: ReturnType<typeof loadRepositoryCensus>) => verifyAuthorityManifest(manifest, { references: census.references, counts: { prismaModels: 999 }, digest: census.digest })],
    ['cloned census', (manifest: unknown, census: ReturnType<typeof loadRepositoryCensus>) => verifyAuthorityManifest(manifest, structuredClone(census))],
    ['symbol-decorated census', (manifest: unknown, census: ReturnType<typeof loadRepositoryCensus>) => verifyAuthorityManifest(manifest, { ...census, [Symbol('canonical')]: true })],
    ['cloned manifest', (manifest: unknown, census: ReturnType<typeof loadRepositoryCensus>) => verifyAuthorityManifest(structuredClone(manifest), census)],
  ])('refuses a forged %s regardless of copied digest or counts', (_name, verify) => {
    const root = repository();
    const result = verify(parseAuthorityManifest(rawManifest()), loadRepositoryCensus(root));
    expect(result).toMatchObject({ ok: false });
  });

  it('requires exact set ownership with no missing, stale, duplicate, or fabricated aggregate refs', () => {
    const root = repository();
    const census = loadRepositoryCensus(root);
    const unowned = parseAuthorityManifest({ ...rawManifest(), entries: [{ ...rawManifest().entries[0], inventoryRefs: [] }] });
    const stale = parseAuthorityManifest(rawManifest('persist:packages/example/src/store.ts#invented'));
    const duplicateRaw = rawManifest();
    duplicateRaw.entries.push({ ...duplicateRaw.entries[0], id: 'm002-duplicate', order: 2, aggregate: 'duplicate' });

    expect(verifyAuthorityManifest(unowned, census)).toMatchObject({ ok: false });
    expect(verifyAuthorityManifest(stale, census)).toMatchObject({ ok: false });
    expect(() => parseAuthorityManifest(duplicateRaw)).toThrow(AuthorityManifestError);
  });

  it('joins sources, owner packages, target models, project scope, and FORCE RLS policy', () => {
    const root = repository();
    const census = loadRepositoryCensus(root);
    const base = rawManifest();
    const invalidCases = [
      { ...base.entries[0], ownerPackage: '@sangfor/missing' },
      { ...base.entries[0], sources: [{ path: 'packages/example/src/store.ts', symbol: 'missing' }] },
      { ...base.entries[0], target: { kind: 'postgres', tables: ['Missing'] } },
    ];

    for (const entry of invalidCases) {
      const manifest = parseAuthorityManifest({ ...base, entries: [entry] });
      expect(verifyAuthorityManifest(manifest, census)).toMatchObject({ ok: false });
    }
    expect(() => parseAuthorityManifest({
      ...base,
      entries: [{ ...base.entries[0], projectScope: 'required', rlsRequired: false }],
    })).toThrow(AuthorityManifestError);
  });

  it.each([
    ['authoritative', { kind: 'excluded' }],
    ['derived', { kind: 'postgres', tables: ['Example'] }],
    ['credential_local', { kind: 'postgres', tables: ['Example'] }],
    ['curated_seed', { kind: 'excluded' }],
  ] as const)('refuses the invalid %s target matrix variant', (classification, target) => {
    const base = rawManifest();
    expect(() => parseAuthorityManifest({
      ...base,
      entries: [{ ...base.entries[0], classification, target }],
    })).toThrow(AuthorityManifestError);
  });

  it('refuses finetune-derived state rebound to Postgres authority', () => {
    const finetune = AUTHORITY_MANIFEST.entries.find((entry) => entry.aggregate === 'finetune_artifacts');
    if (!finetune) throw new AuthorityManifestError(['finetune fixture missing']);
    expect(() => parseAuthorityManifest({
      version: 1,
      entries: [{ ...finetune, target: { kind: 'postgres', tables: ['BlroPmRecord'] } }],
    })).toThrow(AuthorityManifestError);
  });

  it('enforces credential classification from the exact discovered boundary ref', () => {
    const root = repository("export function loadProfile() { return process.env['SANGFOR_JM_CDP_PROFILES_JSON']; }");
    const census = loadRepositoryCensus(root);
    const credentialRef = census.references.find((reference) => reference.startsWith('credential:'));
    const manifest = parseAuthorityManifest(rawManifest(credentialRef));

    expect(verifyAuthorityManifest(manifest, census)).toMatchObject({ ok: false });
  });
});

describe('authoritative project manifest', () => {
  it('splits authoritative RAG source/chunks from derived embeddings and local indexes', () => {
    const authoritative = AUTHORITY_MANIFEST.entries.find((entry) => entry.aggregate === 'rag_source_chunks');
    const derived = AUTHORITY_MANIFEST.entries.find((entry) => entry.aggregate === 'rag_embeddings_local_index');
    expect(authoritative).toMatchObject({ classification: 'authoritative', target: { kind: 'postgres' } });
    expect(derived).toMatchObject({ classification: 'derived', target: { kind: 'excluded' } });
  });
});
