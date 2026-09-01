import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import ts from 'typescript';

const TARGETS = ['apps', 'packages', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const EXCLUDED_DIRECTORIES = new Set(['dist', 'node_modules']);

export const STRICT_RUNTIME_PARSER = /^parseBoundary[A-Za-z0-9]+V1$/u;

function repositoryPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function sourcePaths(root) {
  const paths = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) paths.push(path);
    }
  };
  for (const target of TARGETS) visit(join(root, target));
  return paths.sort();
}

function environmentJsonName(node) {
  if (ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env') {
    return node.name.text.endsWith('_JSON') ? node.name.text : undefined;
  }
  if (ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env'
    && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text.endsWith('_JSON')
      ? node.argumentExpression.text
      : undefined;
  }
  return undefined;
}

export function scanRuntimeBoundarySources(root, ownedParserNames) {
  const parserCalls = [];
  const strictCalls = [];
  const environmentJson = [];
  const unsafeAssertions = [];
  for (const path of sourcePaths(root)) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const file = repositoryPath(root, path);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (STRICT_RUNTIME_PARSER.test(node.expression.text) || ownedParserNames.has(node.expression.text))) {
        const match = { file, parser: node.expression.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
        parserCalls.push(match);
        if (STRICT_RUNTIME_PARSER.test(node.expression.text)) strictCalls.push(match);
      }
      const variable = environmentJsonName(node);
      if (variable !== undefined) {
        environmentJson.push({ file, variable, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
      if (ts.isAsExpression(node) && ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && ts.isIdentifier(node.expression.expression.expression)
        && node.expression.expression.expression.text === 'JSON'
        && node.expression.expression.name.text === 'parse') {
        unsafeAssertions.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { parserCalls, strictCalls, environmentJson, unsafeAssertions };
}
