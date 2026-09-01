import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AUTHORITY_CLASSIFICATIONS,
  AuthorityMigrationManifestSchema,
  registerCanonicalManifest,
  type AuthorityMigrationManifest,
} from './migration-manifest-schema.js';

export const AUTHORITY_MANIFEST_LOCK_PATH = 'packages/sangfor-authority/authority-manifest.lock.json' as const;
export const AUTHORITY_MANIFEST_LOCK_VERSION = 1 as const;

const classCountsSchema = z.object({
  authoritative: z.number().int().nonnegative(),
  derived: z.number().int().nonnegative(),
  credential_local: z.number().int().nonnegative(),
  curated_seed: z.number().int().nonnegative(),
}).strict().readonly();

const authorityManifestLockSchema = z.object({
  schemaVersion: z.literal(AUTHORITY_MANIFEST_LOCK_VERSION),
  aggregateIds: z.array(z.string().min(1)).readonly(),
  classCounts: classCountsSchema,
  manifestSemanticSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryCensusDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceOnlyRefs: z.array(z.string().min(1)).readonly(),
}).strict().readonly();

export type AuthorityManifestLock = z.infer<typeof authorityManifestLockSchema>;

export class AuthorityManifestLockError extends Error {
  readonly name = 'AuthorityManifestLockError';
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new AuthorityManifestLockError('manifest_not_canonicalizable');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function deriveAuthorityManifestLock(
  manifest: AuthorityMigrationManifest,
  repositoryCensusDigest: string,
): AuthorityManifestLock {
  const classCounts: Record<(typeof AUTHORITY_CLASSIFICATIONS)[number], number> = {
    authoritative: 0,
    derived: 0,
    credential_local: 0,
    curated_seed: 0,
  };
  for (const entry of manifest.entries) classCounts[entry.classification] += 1;
  const sourceOnlyRefs = manifest.entries
    .filter((entry) => entry.target.kind === 'source_only')
    .flatMap((entry) => entry.sources.map((source) => `${entry.id}:${source.path}#${source.symbol}`))
    .sort();
  return authorityManifestLockSchema.parse({
    schemaVersion: AUTHORITY_MANIFEST_LOCK_VERSION,
    aggregateIds: manifest.entries.map((entry) => entry.id).sort(),
    classCounts,
    manifestSemanticSha256: createHash('sha256')
      .update(`sangfor.authority-manifest.v1\n${canonical(manifest)}`, 'utf8')
      .digest('hex'),
    repositoryCensusDigest,
    sourceOnlyRefs,
  });
}

export function loadCanonicalAuthorityManifest(
  input: unknown,
  lockPath: string,
): AuthorityMigrationManifest {
  const parsedManifest = AuthorityMigrationManifestSchema.safeParse(input);
  if (!parsedManifest.success) {
    throw new AuthorityManifestLockError('authority_manifest_schema_invalid', { cause: parsedManifest.error });
  }
  const manifest = parsedManifest.data;
  let rawLock: unknown;
  try {
    rawLock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new AuthorityManifestLockError('manifest_lock_unreadable', { cause: error });
  }
  const parsedLock = authorityManifestLockSchema.safeParse(rawLock);
  if (!parsedLock.success) throw new AuthorityManifestLockError('manifest_lock_schema_invalid', { cause: parsedLock.error });
  const expected = deriveAuthorityManifestLock(manifest, parsedLock.data.repositoryCensusDigest);
  if (canonical(parsedLock.data) !== canonical(expected)) throw new AuthorityManifestLockError('manifest_lock_mismatch');
  return registerCanonicalManifest(manifest, parsedLock.data.repositoryCensusDigest);
}
