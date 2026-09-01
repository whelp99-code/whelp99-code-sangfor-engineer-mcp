import { z } from 'zod';
import { resolve } from 'node:path';
import {
  AUTHORITY_MANIFEST_LOCK_PATH,
  loadCanonicalAuthorityManifest,
} from './authority-manifest-lock.js';
import { CORE_MIGRATIONS } from './migration-manifest-core.js';
import { DOMAIN_MIGRATIONS } from './migration-manifest-domains.js';
import { LOCAL_AND_SEED_MIGRATIONS } from './migration-manifest-local.js';
import {
  AuthorityMigrationManifestSchema,
  type AuthorityMigrationManifest,
} from './migration-manifest-schema.js';
import {
  verifyAuthorityManifest,
  type AuthorityManifestCheck,
} from './migration-manifest-verifier.js';

export class AuthorityManifestError extends Error {
  readonly name = 'AuthorityManifestError';
  readonly code = 'AUTHORITY_MANIFEST_INVALID';

  constructor(readonly issues: readonly string[], options?: ErrorOptions) {
    super(issues[0] ?? 'authority migration manifest refused', options);
  }
}

export function parseAuthorityManifest(input: unknown): AuthorityMigrationManifest {
  try {
    return AuthorityMigrationManifestSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AuthorityManifestError(
        error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        { cause: error },
      );
    }
    throw error;
  }
}

const RAW_AUTHORITY_MANIFEST = {
  version: 1,
  entries: [...CORE_MIGRATIONS, ...DOMAIN_MIGRATIONS, ...LOCAL_AND_SEED_MIGRATIONS],
} as const;

export const AUTHORITY_MANIFEST = loadCanonicalAuthorityManifest(
  RAW_AUTHORITY_MANIFEST,
  resolve(AUTHORITY_MANIFEST_LOCK_PATH),
);
export const AUTHORITY_MIGRATIONS = AUTHORITY_MANIFEST.entries;
export const validateAuthorityManifest = verifyAuthorityManifest;
export { verifyAuthorityManifest };
export type AuthorityAggregate = (typeof AUTHORITY_MIGRATIONS)[number]['aggregate'];
export type { AuthorityManifestCheck };
export type { AuthorityMigrationEntry, AuthorityMigrationManifest } from './migration-manifest-schema.js';
