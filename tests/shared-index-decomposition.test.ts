import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as shared from '../packages/shared/src/index.js';

const INDEX_PATH = resolve(import.meta.dirname, '../packages/shared/src/index.ts');
const EXPECTED_EXPORTS = [
  'ApprovalDecision',
  'ApprovalStatus',
  'CanonicalOriginError',
  'CanonicalOriginInput',
  'ConfigPlan',
  'ConfigStep',
  'ConsoleAction',
  'ConsoleActionResult',
  'DirLockTimeoutError',
  'KnowledgeChunk',
  'LocalWriteAuthority',
  'LocalWriteExpectedScope',
  'LocalWriteFencePort',
  'LocalWriteIntent',
  'LocalWriteIntentInput',
  'LocalWriteScope',
  'PaginateOptions',
  'PaginateResult',
  'PRODUCTS',
  'PRODUCT_PRIORITY',
  'ProductCode',
  'ProjectAnalysis',
  'ProjectInput',
  'ProjectType',
  'RiskLevel',
  'SangforProduct',
  'activeEngagementId',
  'appendJsonl',
  'assertBindSafety',
  'assertNoLocalSafetyMarker',
  'canonicalizeUrlOrigin',
  'checkAuth',
  'containsSensitiveLearningTopic',
  'decodeCursor',
  'digestCanonicalOrigin',
  'encodeCursor',
  'expectedLocalWriteScope',
  'explicitLocalPrimaryAuthority',
  'foldJsonlById',
  'isLoopback',
  'localSafetyMarkerPath',
  'localSourceRootIdentity',
  'normalizeLocalWriteIntent',
  'normalizeProduct',
  'nowId',
  'paginate',
  'requireLocalWriteAuthority',
  'resolveBindHost',
  'resolveEngagementScopedData',
  'resolveProductionLocalWriteAuthority',
  'resolveRepoData',
  'withDirLock',
  'writeFileAtomicSync',
] as const;
const EXPECTED_RUNTIME_EXPORTS = EXPECTED_EXPORTS.filter((name) => ![
  'ApprovalDecision',
  'ApprovalStatus',
  'CanonicalOriginInput',
  'ConfigPlan',
  'ConfigStep',
  'ConsoleAction',
  'ConsoleActionResult',
  'KnowledgeChunk',
  'LocalWriteAuthority',
  'LocalWriteExpectedScope',
  'LocalWriteFencePort',
  'LocalWriteIntent',
  'LocalWriteIntentInput',
  'LocalWriteScope',
  'PaginateOptions',
  'PaginateResult',
  'ProductCode',
  'ProjectAnalysis',
  'ProjectInput',
  'ProjectType',
  'RiskLevel',
  'SangforProduct',
].includes(name));

function declaredExports(sourceText: string): readonly string[] {
  const source = ts.createSourceFile(INDEX_PATH, sourceText, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (exported && (
      ts.isClassDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
    ) && statement.name !== undefined) {
      names.push(statement.name.text);
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
  }
  return names.sort();
}

describe('shared compatibility barrel', () => {
  it('stays below the universal source-module size ceiling', () => {
    // Given the shared public entrypoint source.
    const source = readFileSync(INDEX_PATH, 'utf8');

    // When pure source lines are counted without blank or line-comment-only lines.
    const pureLines = source.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'));

    // Then composition remains reviewable and below the hard module ceiling.
    expect(pureLines.length).toBeLessThan(250);
  });

  it('preserves the complete declared and runtime export surfaces', () => {
    // Given the locked compatibility API from before decomposition.
    const source = readFileSync(INDEX_PATH, 'utf8');

    // When static declarations and executable module keys are inspected.
    const staticNames = declaredExports(source);
    const runtimeNames = Object.keys(shared).sort();

    // Then type-only and runtime consumers retain exactly the same names.
    expect(staticNames).toEqual([...EXPECTED_EXPORTS].sort());
    expect(runtimeNames).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it('executes representative helpers through the compatibility entrypoint', () => {
    // Given representative product, security, and pagination inputs.
    const items = [{ id: 'first' }, { id: 'second' }];

    // When each extracted helper family is called through the barrel.
    const product = shared.normalizeProduct('Athena NDR');
    const auth = shared.checkAuth('Bearer token', 'token');
    const page = shared.paginate(items, { limit: 1, getKey: (item) => item.id });

    // Then behavior remains composed through the original import surface.
    expect({ product, auth, ids: page.items.map((item) => item.id) })
      .toEqual({ product: 'NDR', auth: { ok: true }, ids: ['first'] });
  });
});
