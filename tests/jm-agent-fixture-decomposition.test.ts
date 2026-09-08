import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as fixture from './helpers/jm-agent-fixture.js';

const HELPERS = join(import.meta.dirname, 'helpers');
const SIZE_CEILING = 250;
const BARREL = 'jm-agent-fixture.ts';

/** The JM fixture modules the compatibility barrel re-exports, in composition order. */
const BARREL_MODULES = [
  'jm-agent-identity.ts',
  'jm-agent-tls-material.ts',
  'jm-agent-signing-material.ts',
  'jm-agent-authority-artifacts.ts',
  'jm-agent-journal-fixture.ts',
  'jm-agent-execution-port-fake.ts',
] as const;

/** `openssl-local-ca.ts` is a private dependency of the TLS module, never re-exported. */
const EXTRACTED_MODULES = [...BARREL_MODULES, 'openssl-local-ca.ts'] as const;

/** Each module's own surface. Moving a name between modules fails without a ledger edit. */
const MODULE_LEDGERS: Readonly<Record<string, readonly string[]>> = {
  'openssl-local-ca.ts': [
    'CaWindow', 'IssuedLeaf', 'LeafInput',
    'certificateFingerprint256', 'certificateSerial', 'createCa', 'issueLeaf',
  ],
  'jm-agent-identity.ts': [
    'JM_CLIENT_IDENTITY_ID', 'JM_DEVICE_DIGEST', 'JM_INSTALLATION_ID', 'JM_JOURNAL_GENESIS',
    'JM_ORIGIN', 'JM_PROJECT_ID', 'JM_SESSION_ID', 'JM_TENANT_ID', 'originDigest',
  ],
  'jm-agent-tls-material.ts': ['JmTlsMaterial', 'createJmTlsMaterial'],
  'jm-agent-signing-material.ts': [
    'CURRENT_KEY_ID', 'JmSigningMaterial', 'KeyRingOverrides', 'OVERLAP_KEY_ID',
    'createJmSigningMaterial', 'readKeyRing',
  ],
  'jm-agent-authority-artifacts.ts': [
    'CapabilityOverrides', 'ReceiptOverrides', 'SnapshotOverrides', 'browserRequest',
    'buildAuthorityReceipt', 'buildGrantSnapshot', 'mintTaskCapability',
  ],
  'jm-agent-journal-fixture.ts': ['initialiseTestJournal'],
  'jm-agent-execution-port-fake.ts': ['FakeExecutionPort', 'createFakeExecutionPort'],
};

/** The names the nine JM suites and the two BLRO harness scripts bind off the barrel. */
const BARREL_LEDGER = [
  'CURRENT_KEY_ID', 'CapabilityOverrides', 'FakeExecutionPort', 'JM_CLIENT_IDENTITY_ID',
  'JM_DEVICE_DIGEST', 'JM_INSTALLATION_ID', 'JM_JOURNAL_GENESIS', 'JM_ORIGIN', 'JM_PROJECT_ID',
  'JM_SESSION_ID', 'JM_TENANT_ID', 'JmSigningMaterial', 'JmTlsMaterial', 'KeyRingOverrides',
  'OVERLAP_KEY_ID', 'ReceiptOverrides', 'SnapshotOverrides', 'browserRequest',
  'buildAuthorityReceipt', 'buildGrantSnapshot', 'createFakeExecutionPort',
  'createJmSigningMaterial', 'createJmTlsMaterial', 'initialiseTestJournal', 'mintTaskCapability',
  'originDigest', 'readKeyRing',
];

/** The subset of the ledger that exists at runtime; the remaining seven are type-only. */
const BARREL_RUNTIME_LEDGER = [
  'CURRENT_KEY_ID', 'JM_CLIENT_IDENTITY_ID', 'JM_DEVICE_DIGEST', 'JM_INSTALLATION_ID',
  'JM_JOURNAL_GENESIS', 'JM_ORIGIN', 'JM_PROJECT_ID', 'JM_SESSION_ID', 'JM_TENANT_ID',
  'OVERLAP_KEY_ID', 'browserRequest', 'buildAuthorityReceipt', 'buildGrantSnapshot',
  'createFakeExecutionPort', 'createJmSigningMaterial', 'createJmTlsMaterial',
  'initialiseTestJournal', 'mintTaskCapability', 'originDigest', 'readKeyRing',
];

function moduleSource(name: string): string {
  const path = join(HELPERS, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function pureLoc(name: string): number {
  // A missing module counts as unbounded so the size census names it too.
  if (!existsSync(join(HELPERS, name))) return Number.POSITIVE_INFINITY;
  return moduleSource(name).split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*');
  }).length;
}

function parseModule(name: string): ts.SourceFile {
  return ts.createSourceFile(join(HELPERS, name), moduleSource(name), ts.ScriptTarget.Latest, true);
}

function ownDeclarationName(statement: ts.Statement): readonly string[] {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
  }
  return [];
}

/** Exported names of a module, counting own declarations and `export … from` clauses alike. */
function exportedNames(name: string): readonly string[] {
  const names = parseModule(name).statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.map((element) => element.name.text);
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((it) => it.kind === ts.SyntaxKind.ExportKeyword) === true;
    return exported ? ownDeclarationName(statement) : [];
  });
  return [...new Set(names)].sort();
}

/** Relative specifiers a module imports or re-exports, for example `./jm-agent-identity.js`. */
function localSpecifiers(name: string): readonly string[] {
  return parseModule(name).statements.flatMap((statement) => (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('./')
      ? [statement.moduleSpecifier.text]
      : []
  ));
}

function moduleSpecifier(name: string): string {
  return `./${name.replace(/\.ts$/u, '.js')}`;
}

describe('JM agent fixture decomposition', () => {
  it('Given every JM fixture module, When pure lines are counted, Then each stays under the ceiling', () => {
    // Given the barrel plus every module the JM fixture surface is composed from.
    const modules = [BARREL, ...EXTRACTED_MODULES];

    // When pure source lines are counted, blank and comment-only lines excluded.
    const oversized = modules
      .map((name) => [name, pureLoc(name)] as const)
      .filter(([, lines]) => lines >= SIZE_CEILING)
      .map(([name, lines]) => `${name}:${String(lines)}`);

    // Then no module exceeds a single reviewer's working memory, and none is missing.
    expect(oversized).toEqual([]);
  });

  it('Given the extracted modules, When their exports are read, Then every ledger is exact', () => {
    // Given the per-module ownership ledger.
    const expected = Object.fromEntries(
      EXTRACTED_MODULES.map((name) => [name, [...(MODULE_LEDGERS[name] ?? [])].sort()]),
    );

    // When each module's exported names are read off the syntax tree.
    const actual = Object.fromEntries(EXTRACTED_MODULES.map((name) => [name, exportedNames(name)]));

    // Then each concern owns exactly its own names, and nothing leaked between modules.
    expect(actual).toEqual(expected);
  });

  it('Given the compatibility barrel, When its surface is read, Then the JM ledger is unchanged', () => {
    // Given the 27 names every JM suite and harness script binds today.
    // When the barrel's re-export clauses and its loaded runtime keys are enumerated.
    const declared = exportedNames(BARREL);
    const runtime = Object.keys(fixture).sort();

    // Then the split neither dropped a name nor published a private OpenSSL helper.
    expect(declared).toEqual([...BARREL_LEDGER].sort());
    expect(runtime).toEqual([...BARREL_RUNTIME_LEDGER].sort());
  });

  it('Given the barrel, When its statements are read, Then it only re-exports the composed modules', () => {
    // Given the barrel source.
    const { statements } = parseModule(BARREL);

    // When each statement is classified and its specifier collected.
    const ownLogic = statements.filter((statement) => !ts.isExportDeclaration(statement)
      || statement.moduleSpecifier === undefined).length;
    const specifiers = [...localSpecifiers(BARREL)].sort();

    // Then the barrel carries no logic of its own and composes exactly the six JM modules.
    expect(ownLogic).toBe(0);
    expect(specifiers).toEqual(BARREL_MODULES.map(moduleSpecifier).sort());
  });

  it('Given the extracted modules, When their imports are read, Then none depends on the barrel', () => {
    // Given every extracted module.
    // When their relative specifiers are read off the syntax tree.
    const cyclic = EXTRACTED_MODULES
      .filter((name) => localSpecifiers(name).includes(moduleSpecifier(BARREL)));

    // Then composition runs one way only, from the barrel outwards.
    expect(cyclic).toEqual([]);
  });
});
