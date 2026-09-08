import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHORITY_CLASSIFICATIONS } from './migration-manifest-schema.js';
import {
  canonicalCensusContext,
  isCanonicalCensus,
  type CensusContext,
  type RepositoryCensus,
} from './repository-census-context.js';
import {
  canonicalManifestCensusDigest,
  isCanonicalManifest,
  type AuthorityMigrationEntry,
  type AuthorityMigrationManifest,
} from './migration-manifest-schema.js';

export type AuthorityManifestCheck =
  | {
    readonly ok: true;
    readonly aggregateCount: number;
    readonly classes: Readonly<Record<(typeof AUTHORITY_CLASSIFICATIONS)[number], number>>;
    readonly inventory: RepositoryCensus['counts'];
    readonly digest: string;
  }
  | { readonly ok: false; readonly issues: readonly string[] };

function referenceSource(reference: string): string | null {
  if (reference.startsWith('prisma:model:')) return `prisma/schema.prisma#${reference.slice('prisma:model:'.length)}`;
  const match = /^(?:persist|credential):(.+)#([^#]+)$/u.exec(reference);
  return match?.[1] && match[2] ? `${match[1]}#${match[2]}` : null;
}

function validateTarget(entry: AuthorityMigrationEntry, issues: string[], context: CensusContext): void {
  switch (entry.target.kind) {
    case 'postgres':
      for (const table of entry.target.tables) {
        if (!context.targetTables.has(table)) issues.push(`TARGET_TABLE_MISSING: ${entry.id}:${table}`);
        if (entry.projectScope === 'required' && !context.projectScopedTables.has(table)) issues.push(`TARGET_PROJECT_SCOPE_MISSING: ${entry.id}:${table}`);
        if (entry.rlsRequired && !context.rlsTables.has(table)) issues.push(`TARGET_FORCE_RLS_MISSING: ${entry.id}:${table}`);
      }
      break;
    case 'jm_local':
      for (const reference of entry.target.inventoryRefs) {
        if (!entry.inventoryRefs.includes(reference)) issues.push(`LOCAL_TARGET_NOT_OWNED: ${entry.id}:${reference}`);
      }
      break;
    case 'excluded':
    case 'source_only':
      break;
    default: {
      const exhaustive: never = entry.target;
      return exhaustive;
    }
  }
}

export function verifyAuthorityManifest(manifestInput: unknown, censusInput: unknown): AuthorityManifestCheck {
  if (!isCanonicalManifest(manifestInput)) return { ok: false, issues: ['MANIFEST_NOT_CANONICAL'] };
  if (!isCanonicalCensus(censusInput)) return { ok: false, issues: ['CENSUS_NOT_CANONICAL'] };
  const context = canonicalCensusContext(censusInput);
  if (!context) return { ok: false, issues: ['CENSUS_NOT_CANONICAL'] };
  const census = censusInput;
  const manifest: AuthorityMigrationManifest = manifestInput;
  const issues: string[] = [];
  if (canonicalManifestCensusDigest(manifest) !== census.digest) issues.push('census_digest_mismatch');
  const owners = new Map<string, string>();

  for (const entry of manifest.entries) {
    if (!context.packageNames.has(entry.ownerPackage)) issues.push(`OWNER_PACKAGE_MISSING: ${entry.id}:${entry.ownerPackage}`);
    if (entry.inventoryRefs.length === 0 && entry.classification !== 'curated_seed') issues.push(`AGGREGATE_WITHOUT_INVENTORY: ${entry.id}`);
    const declaredSources = new Set(entry.sources.map((source) => `${source.path}#${source.symbol}`));
    for (const source of entry.sources) {
      const pathExists = existsSync(join(context.repoRoot, source.path));
      const curated = entry.classification === 'curated_seed' && source.symbol === 'curated-seed:v1';
      if (!pathExists) issues.push(`SOURCE_PATH_MISSING: ${entry.id}:${source.path}`);
      if (!curated && !context.sourceSymbols.has(`${source.path}#${source.symbol}`)) issues.push(`SOURCE_SYMBOL_MISSING: ${entry.id}:${source.path}#${source.symbol}`);
    }
    for (const reference of entry.inventoryRefs) {
      const prior = owners.get(reference);
      if (prior) issues.push(`DUPLICATE_INVENTORY_OWNER: ${reference}:${prior}:${entry.id}`);
      else owners.set(reference, entry.id);
      if (!context.references.has(reference)) issues.push(`STALE_INVENTORY_REFERENCE: ${entry.id}:${reference}`);
      const expectedSource = referenceSource(reference);
      if (expectedSource && !declaredSources.has(expectedSource)) issues.push(`INVENTORY_SOURCE_MISSING: ${entry.id}:${expectedSource}`);
      if (context.credentialReferences.has(reference) && entry.classification !== 'credential_local') issues.push(`CREDENTIAL_TO_AUTHORITY_REFUSED: ${entry.id}:${reference}`);
      if (entry.classification === 'credential_local' && !context.credentialReferences.has(reference)) issues.push(`NON_CREDENTIAL_IN_CREDENTIAL_AGGREGATE: ${entry.id}:${reference}`);
    }
    validateTarget(entry, issues, context);
  }
  for (const reference of context.references) if (!owners.has(reference)) issues.push(`UNOWNED_INVENTORY: ${reference}`);
  if (issues.length > 0) return { ok: false, issues };

  const classes: Record<(typeof AUTHORITY_CLASSIFICATIONS)[number], number> = {
    authoritative: 0, derived: 0, credential_local: 0, curated_seed: 0,
  };
  for (const entry of manifest.entries) classes[entry.classification] += 1;
  return {
    ok: true,
    aggregateCount: manifest.entries.length,
    classes,
    inventory: census.counts,
    digest: census.digest,
  };
}
