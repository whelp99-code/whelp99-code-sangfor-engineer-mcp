import { z } from 'zod';

export const AUTHORITY_CLASSIFICATIONS = [
  'authoritative',
  'derived',
  'credential_local',
  'curated_seed',
] as const;

const identifierSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/u);
const migrationIdSchema = z.string().regex(/^m\d{3}-[a-z][a-z0-9-]*$/u);
const sourceSchema = z.object({
  path: z.string().min(1).refine((path) => !path.startsWith('/') && !path.includes('..'), 'must be repository-relative'),
  symbol: z.string().min(1),
}).strict();
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('postgres'), tables: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('jm_local'), inventoryRefs: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('excluded') }).strict(),
  z.object({ kind: z.literal('source_only') }).strict(),
]);

export const AuthorityMigrationEntrySchema = z.object({
  id: migrationIdSchema,
  order: z.number().int().positive(),
  aggregate: identifierSchema,
  ownerPackage: z.string().regex(/^@sangfor(?:-engineer)?\/[a-z0-9-]+$/u),
  classification: z.enum(AUTHORITY_CLASSIFICATIONS),
  sources: z.array(sourceSchema).min(1),
  target: targetSchema,
  projectScope: z.enum(['required', 'not_applicable']),
  rlsRequired: z.boolean(),
  secretPolicy: z.enum(['redact_before_authority', 'digest_only', 'forbid', 'none']),
  prerequisites: z.array(z.string().min(1)),
  dependsOn: z.array(migrationIdSchema),
  inventoryRefs: z.array(z.string().min(1)),
}).strict();

export const AuthorityMigrationManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(AuthorityMigrationEntrySchema).min(1),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  const orders = new Set<number>();
  const aggregates = new Set<string>();
  const inventoryOwners = new Set<string>();
  const sourceOnlyOwners = new Set<string>();
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  manifest.entries.forEach((entry, index) => {
    const issue = (path: string, message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, path], message });
    if (ids.has(entry.id)) issue('id', 'duplicate migration id');
    if (orders.has(entry.order) || entry.order !== index + 1) issue('order', 'orders must be unique, contiguous, and array-ordered');
    if (aggregates.has(entry.aggregate)) issue('aggregate', 'duplicate aggregate');
    ids.add(entry.id); orders.add(entry.order); aggregates.add(entry.aggregate);
    for (const reference of entry.inventoryRefs) {
      if (inventoryOwners.has(reference)) issue('inventoryRefs', `duplicate inventory owner ${reference}`);
      inventoryOwners.add(reference);
    }
    switch (entry.classification) {
      case 'authoritative':
        if (entry.target.kind !== 'postgres') issue('target', 'authoritative target must be postgres');
        break;
      case 'derived':
        if (entry.target.kind !== 'excluded' && entry.target.kind !== 'jm_local') issue('target', 'derived data cannot target authority');
        break;
      case 'credential_local':
        if ((entry.target.kind !== 'excluded' && entry.target.kind !== 'jm_local') || entry.secretPolicy !== 'forbid') issue('target', 'credential-local data must remain local or excluded and forbidden');
        break;
      case 'curated_seed':
        if (entry.target.kind !== 'source_only') issue('target', 'curated seeds are source-only');
        break;
      default: entry.classification satisfies never;
    }
    if (entry.target.kind === 'source_only') {
      for (const source of entry.sources) {
        const reference = `${source.path}#${source.symbol}`;
        if (sourceOnlyOwners.has(reference)) issue('sources', `duplicate source-only owner ${reference}`);
        sourceOnlyOwners.add(reference);
      }
    }
    if (entry.projectScope === 'required' && entry.classification === 'authoritative' && !entry.rlsRequired) issue('rlsRequired', 'project authority requires RLS');
    for (const dependency of entry.dependsOn) {
      const target = byId.get(dependency);
      if (!target) issue('dependsOn', `unknown dependency ${dependency}`);
      else if (target.order >= entry.order) issue('dependsOn', `dependency ${dependency} must be earlier`);
    }
  });
});

export type AuthorityMigrationEntry = z.infer<typeof AuthorityMigrationEntrySchema>;
export type AuthorityMigrationManifest = z.infer<typeof AuthorityMigrationManifestSchema>;

const canonicalManifests = new WeakMap<object, string>();

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  Object.freeze(value);
}

export function registerCanonicalManifest(
  manifest: AuthorityMigrationManifest,
  repositoryCensusDigest: string,
): AuthorityMigrationManifest {
  deepFreeze(manifest);
  canonicalManifests.set(manifest, repositoryCensusDigest);
  return manifest;
}

export function isCanonicalManifest(input: unknown): input is AuthorityMigrationManifest {
  return typeof input === 'object' && input !== null && canonicalManifests.has(input);
}

export function canonicalManifestCensusDigest(manifest: AuthorityMigrationManifest): string | null {
  return canonicalManifests.get(manifest) ?? null;
}
