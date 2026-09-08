type ManifestEntry = {
  readonly classification: string;
  readonly projectScope: string;
  readonly rlsRequired: boolean;
  readonly target: { readonly kind: string; readonly tables?: readonly string[] };
};

type AuthorityManifest = {
  readonly entries: readonly ManifestEntry[];
};

export class ScopedAuthorityModelError extends Error {
  readonly name = 'ScopedAuthorityModelError';
}

function schemaModels(schema: string): ReadonlyMap<string, string> {
  const models = new Map<string, string>();
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gmu)) {
    const name = match[1];
    const body = match[2];
    if (name !== undefined && body !== undefined) models.set(name, body);
  }
  return models;
}

export function deriveScopedAuthorityModels(
  schema: string,
  manifest: AuthorityManifest,
): readonly string[] {
  const models = schemaModels(schema);
  const schemaScoped = [...models.entries()]
    .filter(([name, body]) => name.startsWith('Blro') && /^\s*projectId\s+String\b/mu.test(body))
    .map(([name]) => name);
  if (models.has('BlroProject')) schemaScoped.push('BlroProject');

  const requiredTargets = manifest.entries
    .filter((entry) => entry.classification === 'authoritative'
      && entry.projectScope === 'required' && entry.rlsRequired && entry.target.kind === 'postgres')
    .flatMap((entry) => entry.target.tables ?? []);
  for (const table of requiredTargets) {
    const body = models.get(table);
    if (body === undefined) throw new ScopedAuthorityModelError(`AUTHORITY_TARGET_MISSING: ${table}`);
    if (!/^\s*projectId\s+String\b/mu.test(body)) {
      throw new ScopedAuthorityModelError(`AUTHORITY_TARGET_UNSCOPED: ${table}`);
    }
  }

  return [...new Set([...schemaScoped, ...requiredTargets])].sort();
}

export type TenantProjectModel = {
  readonly table: string;
  readonly projectRelationFields: readonly string[];
  readonly projectReferenceFields: readonly string[];
};

export function deriveTenantProjectModels(
  schema: string,
  tables: readonly string[],
): readonly TenantProjectModel[] {
  const models = schemaModels(schema);
  return tables.flatMap((table) => {
    const body = models.get(table) ?? '';
    if (!/^\s*tenantId\s+String\b/mu.test(body) || !/^\s*projectId\s+String\b/mu.test(body)) return [];
    const relation = /^\s*\w+\s+BlroProject[^\n]*@relation\(fields:\s*\[([^\n]+?)\],\s*references:\s*\[([^\n]+?)\]/mu.exec(body);
    if (!relation?.[1] || !relation[2]) throw new ScopedAuthorityModelError(`AUTHORITY_COMPOSITE_PROJECT_RELATION_MISSING: ${table}`);
    return [{
      table,
      projectRelationFields: relation[1].split(',').map((field) => field.trim()),
      projectReferenceFields: relation[2].split(',').map((field) => field.trim()),
    }];
  });
}

export type OwnershipExpectation = {
  readonly table: string;
  readonly parent: string;
  readonly deleteAction: 'CASCADE' | 'RESTRICT';
  readonly ownershipColumn: 'tenantId' | 'projectId';
};

export function projectColumnFor(table: string): 'id' | 'projectId' {
  return table === 'BlroProject' ? 'id' : 'projectId';
}

export function deriveOwnershipExpectations(
  schema: string,
  tables: readonly string[],
): readonly OwnershipExpectation[] {
  const models = schemaModels(schema);
  return tables.map((table) => {
    if (table === 'BlroProject') {
      return { table, parent: 'BlroTenant', deleteAction: 'RESTRICT', ownershipColumn: 'tenantId' };
    }
    const body = models.get(table) ?? '';
    const relations = [...body.matchAll(/^\s*\w+\s+(\w+)[^\n]*@relation\(fields:\s*\[([^\n]+?)\].*onDelete:\s*(Restrict|Cascade)\)/gmu)];
    const relation = relations.find((match) => match[2]?.split(',').map((field) => field.trim()).includes('projectId'));
    const parent = relation?.[1];
    const action = relation?.[3];
    if (parent === undefined || action === undefined) {
      throw new ScopedAuthorityModelError(`AUTHORITY_OWNERSHIP_UNDECLARED: ${table}`);
    }
    return {
      table,
      parent,
      deleteAction: action === 'Cascade' ? 'CASCADE' : 'RESTRICT',
      ownershipColumn: 'projectId',
    };
  });
}
