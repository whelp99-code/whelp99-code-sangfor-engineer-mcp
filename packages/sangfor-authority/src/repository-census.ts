import { createHash } from 'node:crypto';
import { analyzeSourceAst } from './repository-census-ast.js';
import {
  registerCanonicalCensus,
  type CensusContext,
  type RepositoryCensus,
} from './repository-census-context.js';
import { collectRepositoryFiles } from './repository-census-files.js';

export function loadRepositoryCensus(root: string): RepositoryCensus {
  const files = collectRepositoryFiles(root);
  const ast = analyzeSourceAst(root, files.sourcePaths);
  const prismaReferences = [...files.prismaModels.keys()].map((name) => `prisma:model:${name}`);
  const references = [...new Set([
    ...prismaReferences,
    ...ast.persistenceReferences,
    ...ast.credentialReferences,
  ])].sort();
  const sourceSymbols = new Set(ast.sourceSymbols);
  for (const reference of [...ast.persistenceReferences, ...ast.credentialReferences]) {
    const match = /^(?:persist|credential):(.+)#([^#]+)$/u.exec(reference);
    if (match?.[1] && match[2]) sourceSymbols.add(`${match[1]}#${match[2]}`);
  }
  for (const name of files.prismaModels.keys()) sourceSymbols.add(`prisma/schema.prisma#${name}`);
  const credentialReferences = new Set(ast.credentialReferences);
  const semanticLines = references.map((reference) => {
    if (reference.startsWith('prisma:model:')) {
      return `${reference}\0${files.prismaModels.get(reference.slice('prisma:model:'.length)) ?? ''}`;
    }
    const persistenceReference = reference.replace(/^credential:/u, 'persist:');
    return `${reference}\0${ast.semantics.get(persistenceReference) ?? ''}`;
  });
  const census: RepositoryCensus = {
    references,
    counts: {
      prismaModels: prismaReferences.length,
      persistenceSymbols: ast.persistenceReferences.length,
      credentialBoundaries: ast.credentialReferences.length,
    },
    digest: createHash('sha256').update(semanticLines.join('\n')).digest('hex'),
  };
  const context: CensusContext = {
    repoRoot: root,
    references: new Set(references),
    credentialReferences,
    sourceSymbols,
    packageNames: files.packageNames,
    targetTables: files.targetTables,
    projectScopedTables: files.projectScopedTables,
    rlsTables: files.rlsTables,
  };
  return registerCanonicalCensus(census, context);
}

export const censusRepository = loadRepositoryCensus;
export type { RepositoryCensus } from './repository-census-context.js';
