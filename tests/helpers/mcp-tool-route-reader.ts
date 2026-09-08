import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type ToolRoute = {
  readonly toolName: string;
  readonly catalogSource: string;
  readonly handlerIdentifier: string;
  readonly handlerAstSha256: string;
};

function handlerRoute(toolName: string, catalogSource: string, handler: ts.Expression, source: ts.SourceFile): ToolRoute {
  const handlerSource = handler.getText(source);
  const executable = ts.transpileModule(`const handler = ${handlerSource};`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.trim();
  const handlerIdentifier = ts.isIdentifier(handler)
    ? handler.text
    : executable;
  return {
    toolName,
    catalogSource,
    handlerIdentifier,
    handlerAstSha256: createHash('sha256').update(executable).digest('hex'),
  };
}

function routeFromDefinition(
  toolName: string,
  catalogSource: string,
  definition: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): ToolRoute {
  const handler = definition.properties.find((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(source) === 'handler');
  if (handler === undefined || !ts.isPropertyAssignment(handler)) {
    throw new Error(`HANDLER_ROUTE_MISSING: ${toolName}`);
  }
  return handlerRoute(toolName, catalogSource, handler.initializer, source);
}

function catalogRoutes(path: string, relativePath: string, sourceText = readFileSync(path, 'utf8')): readonly ToolRoute[] {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes: ToolRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) continue;
        const name = element.elements[0];
        const definition = element.elements[1];
        if (name !== undefined && ts.isStringLiteralLike(name)
          && definition !== undefined && ts.isObjectLiteralExpression(definition)
          && name.text.startsWith('sangfor_')) {
          routes.push(routeFromDefinition(name.text, relativePath, definition, source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

function iagRoutes(path: string, relativePath: string): readonly ToolRoute[] {
  const sourceText = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes: ToolRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined && ts.isObjectLiteralExpression(node.expression)) {
      for (const property of node.expression.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
          || !property.name.text.startsWith('sangfor_') || !ts.isObjectLiteralExpression(property.initializer)) continue;
        routes.push(routeFromDefinition(property.name.text, relativePath, property.initializer, source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

export function readToolRoutes(repoRoot: string): readonly ToolRoute[] {
  const sourceRoot = join(repoRoot, 'apps/mcp-server/src');
  const routes = readdirSync(sourceRoot)
    .filter((name) => name.endsWith('-tool-catalog.ts'))
    .sort()
    .flatMap((name) => catalogRoutes(join(sourceRoot, name), `apps/mcp-server/src/${name}`));
  routes.push(...iagRoutes(
    join(sourceRoot, 'iag-orchestrator-tools.ts'),
    'apps/mcp-server/src/iag-orchestrator-tools.ts',
  ));
  return routes.sort((left, right) => left.toolName.localeCompare(right.toolName));
}

export function readMutatedCatalogRoutes(
  repoRoot: string,
  catalogFile: string,
  sourceText: string,
): readonly ToolRoute[] {
  return catalogRoutes(join(repoRoot, catalogFile), catalogFile, sourceText);
}
