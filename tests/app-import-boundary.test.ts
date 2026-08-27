import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const APPS_ROOT = join(ROOT, 'apps');
const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const EXPECTED_APPS = [
  'control-tower',
  'http-bridge',
  'jm-browser-agent',
  'mcp-server',
  'mock-sangfor-console',
  'operator-console',
] as const;
const EXPECTED_SOURCE_COUNT = 81;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'generated', 'node_modules', 'out',
]);
const REMOVED_GUARD_SPECIFIER = ['..', '..', 'http-bridge', 'src', 'tool-guard.js'].join('/');

type AppImport = {
  readonly importer: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
};

function sourceFilesUnder(root: string): readonly string[] {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name)) sources.push(path);
    }
  };
  visit(root);
  return sources.sort();
}

function appDirectories(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
      && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function appName(filePath: string): string | undefined {
  const parts = relative(ROOT, filePath).split(sep);
  return parts[0] === 'apps' ? parts[1] : undefined;
}

function importedSpecifiers(node: ts.Node): readonly string[] {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined
    && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return [node.moduleSpecifier.text];
  }
  if (ts.isImportTypeNode(node)
    && ts.isLiteralTypeNode(node.argument)
    && ts.isStringLiteralLike(node.argument.literal)) {
    return [node.argument.literal.text];
  }
  if (ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression !== undefined
    && ts.isStringLiteralLike(node.moduleReference.expression)) {
    return [node.moduleReference.expression.text];
  }
  if (ts.isCallExpression(node)
    && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    && node.arguments.length === 1) {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isStringLiteralLike(argument)) return [argument.text];
  }
  return [];
}

function resolveImport(
  specifier: string,
  importer: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const resolvedModule = ts.resolveModuleName(specifier, importer, compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (resolvedModule !== undefined) return resolvedModule;
  return specifier.startsWith('.') ? resolve(dirname(importer), specifier) : undefined;
}

function crossAppImports(
  files: readonly string[],
  compilerOptions: ts.CompilerOptions = parsedConfig.options,
): readonly AppImport[] {
  const violations: AppImport[] = [];
  for (const importer of files) {
    const source = ts.createSourceFile(
      importer,
      readFileSync(importer, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const importerApp = appName(importer);
    const visit = (node: ts.Node): void => {
      for (const specifier of importedSpecifiers(node)) {
        const targetPath = resolveImport(specifier, importer, compilerOptions);
        const targetApp = targetPath === undefined ? undefined : appName(targetPath);
        if (importerApp !== undefined && targetPath !== undefined
          && targetApp !== undefined && importerApp !== targetApp) {
          violations.push({
            importer: relative(ROOT, importer),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            specifier,
            target: relative(ROOT, targetPath),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe('application dependency boundary', () => {
  it('rejects every cross-app import in production source', () => {
    // Given the locked non-empty application and production-source census.
    const apps = appDirectories(APPS_ROOT);
    const sources = sourceFilesUnder(APPS_ROOT);
    expect(apps).toEqual(EXPECTED_APPS);
    expect(sources).toHaveLength(EXPECTED_SOURCE_COUNT);

    // When their static and runtime imports are resolved by the TypeScript AST.
    const violations = crossAppImports(sources);

    // Then apps depend only on packages or their own app modules.
    expect(violations).toEqual([]);
  });

  it('detects the old MCP line-70 edge and every supported import form', () => {
    // Given mutations reproducing the old relative edge plus alias, dynamic,
    // CommonJS, type-only, and import-equals forms.
    const importer = join(ROOT, 'apps/mcp-server/src/task-35-boundary-fixture.ts');
    const fixture = [
      `import { authorizeToolCall } from '${REMOVED_GUARD_SPECIFIER}';`,
      "import { createBridgeServer } from '@apps/http-bridge/src/server.js';",
      "import type { BridgeServerDeps } from '@apps/http-bridge/src/server.js';",
      "const dynamicModule = import('@apps/http-bridge/src/server.js');",
      "const requiredModule = require('@apps/http-bridge/src/server.js');",
      "import bridge = require('@apps/http-bridge/src/server.js');",
      "export { createBridgeServer as exportedBridge } from '@apps/http-bridge/src/server.js';",
      `type RelativeImportQuery = import('${REMOVED_GUARD_SPECIFIER}').ToolAuthDecision;`,
      "type AliasImportQuery = import('@apps/http-bridge/src/server.js').BridgeServerDeps;",
      'void [authorizeToolCall, createBridgeServer, dynamicModule, requiredModule, bridge];',
    ].join('\n');
    const host = { ...ts.sys, readFile: (path: string) => path === importer ? fixture : ts.sys.readFile(path) };
    const source = ts.createSourceFile(importer, fixture, ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      specifiers.push(...importedSpecifiers(node));
      ts.forEachChild(node, visit);
    };
    visit(source);
    const options = {
      ...parsedConfig.options,
      baseUrl: ROOT,
      paths: { ...parsedConfig.options.paths, '@apps/*': ['apps/*'] },
    } satisfies ts.CompilerOptions;
    const violations = specifiers.filter((specifier) => {
      const resolvedModule = ts.resolveModuleName(specifier, importer, options, host)
        .resolvedModule?.resolvedFileName;
      const target = resolvedModule ?? (specifier.startsWith('.')
        ? resolve(dirname(importer), specifier)
        : undefined);
      return target !== undefined && appName(target) === 'http-bridge';
    });

    // Then every forbidden edge is rejected, including require() and the exact
    // import that previously occupied apps/mcp-server/src/index.ts:70.
    expect(violations).toEqual([
      REMOVED_GUARD_SPECIFIER,
      '@apps/http-bridge/src/server.js',
      '@apps/http-bridge/src/server.js',
      '@apps/http-bridge/src/server.js',
      '@apps/http-bridge/src/server.js',
      '@apps/http-bridge/src/server.js',
      '@apps/http-bridge/src/server.js',
      REMOVED_GUARD_SPECIFIER,
      '@apps/http-bridge/src/server.js',
    ]);
  });
});
