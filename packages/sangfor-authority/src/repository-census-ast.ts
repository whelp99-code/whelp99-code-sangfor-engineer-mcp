import ts from 'typescript';
import { repositoryPath } from './repository-census-files.js';

export type AstCensus = {
  readonly persistenceReferences: readonly string[];
  readonly credentialReferences: readonly string[];
  readonly sourceSymbols: ReadonlySet<string>;
  readonly semantics: ReadonlyMap<string, string>;
};

type Owner = {
  readonly reference: string;
  readonly declarationName: string;
  readonly semanticSource: string;
  readonly calledNames: Set<string>;
  persistent: boolean;
  credential: boolean;
};

const WRITE_CALLS = new Set([
  'appendFile', 'appendFileSync', 'appendJsonl',
  'createWriteStream', 'rename', 'renameSync', 'writeFile', 'writeFileSync',
  'writeFileAtomic', 'writeFileAtomicSync', 'atomicWrite',
]);
const OPEN_CALLS = new Set(['open', 'openSync']);
const PERSISTENCE_HELPER = /^(?:append|atomic|persist|record|rename|save|write)/iu;
const SENSITIVE_ATOM = /(?:^|[_./\\-])(?:SECRET|PASSWORD|PASSWD|TOKEN|COOKIE|CREDENTIALS?|PRIVATE[_-]?KEY|CERTIFICATE|CERT)(?:$|[_./\\-])/u;
const BROWSER_CONTEXT = /(?:^|[_./\\-])(?:BROWSER|CDP)(?:$|[_./\\-])/u;
const SESSION_CONTEXT = /(?:^|[_./\\-])(?:PROFILES?|SESSIONS?|STORAGE|STATE|AUTH|COOKIES?)(?:$|[_./\\-])/u;
const BENIGN_METRIC = /(?:^|[_./\\-])(?:TIMEOUT|COUNT|LIMIT|INTERVAL|TTL|RETRIES|PORT)(?:$|[_./\\-])/u;
const CREDENTIAL_PATH = /[/\\]|\.(?:json|pem|key|crt|p12|state)$/u;

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) return expression.argumentExpression.text;
  return null;
}

function stringValue(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

function isDirectPersistence(call: ts.CallExpression): boolean {
  const name = callName(call.expression);
  if (!name) return false;
  if (WRITE_CALLS.has(name)) return true;
  if (OPEN_CALLS.has(name)) return /^[awx]/u.test(stringValue(call.arguments[1]) ?? '');
  if (name !== 'query' && name !== '$queryRawUnsafe' && name !== '$executeRawUnsafe') return false;
  return /^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/iu.test(stringValue(call.arguments[0]) ?? '');
}

function isProcessEnvironment(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env';
}

function isCredentialBoundary(value: string): boolean {
  const normalized = value.toUpperCase();
  if (BENIGN_METRIC.test(normalized)) return false;
  return SENSITIVE_ATOM.test(normalized)
    || (BROWSER_CONTEXT.test(normalized) && SESSION_CONTEXT.test(normalized));
}

function isPathBoundaryLiteral(parent: ts.Node | null): boolean {
  return parent !== null
    && ts.isCallExpression(parent)
    && ['join', 'resolve', 'open', 'openSync', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync']
      .includes(callName(parent.expression) ?? '');
}

function credentialEnvironmentKey(node: ts.Node): string | null {
  if (ts.isElementAccessExpression(node)
    && isProcessEnvironment(node.expression)
    && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  if (ts.isPropertyAccessExpression(node) && isProcessEnvironment(node.expression)) return node.name.text;
  return null;
}

function topLevelSymbols(sourceFile: ts.SourceFile, path: string): readonly string[] {
  const symbols: string[] = [`${path}#<module>`];
  for (const statement of sourceFile.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      symbols.push(`${path}#${statement.name.text}`);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) symbols.push(`${path}#${declaration.name.text}`);
      }
    }
  }
  return symbols;
}

export function analyzeSourceAst(root: string, sourcePaths: readonly string[]): AstCensus {
  const program = ts.createProgram(sourcePaths, {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const owners = new Map<string, Owner>();
  const sourceSymbols = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourcePaths.includes(sourceFile.fileName)) continue;
    const path = repositoryPath(root, sourceFile.fileName);
    for (const symbol of topLevelSymbols(sourceFile, path)) sourceSymbols.add(symbol);
    const moduleReference = `persist:${path}#<module>`;
    const moduleOwner: Owner = {
      reference: moduleReference,
      declarationName: '<module>',
      semanticSource: sourceFile.getText(),
      calledNames: new Set(),
      persistent: false,
      credential: false,
    };
    owners.set(moduleReference, moduleOwner);
    const visit = (node: ts.Node, inheritedOwner: Owner, parent: ts.Node | null): void => {
      let owner = inheritedOwner;
      let declarationName: string | null = null;
      if (ts.isClassDeclaration(node) && node.name) declarationName = node.name.text;
      else if (ts.isFunctionDeclaration(node) && node.name) declarationName = node.name.text;
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) declarationName = node.name.text;
      if (declarationName) {
        const reference = `persist:${path}#${declarationName}`;
        const declaredOwner: Owner = {
          reference,
          declarationName,
          semanticSource: node.getText(sourceFile),
          calledNames: new Set(),
          persistent: false,
          credential: false,
        };
        owners.set(reference, declaredOwner);
        owner = declaredOwner;
      }
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name) owner.calledNames.add(name);
        if (isDirectPersistence(node)) owner.persistent = true;
      }
      const environmentKey = credentialEnvironmentKey(node);
      if (environmentKey && isCredentialBoundary(environmentKey)) owner.credential = true;
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && isPathBoundaryLiteral(parent)
        && CREDENTIAL_PATH.test(node.text)
        && isCredentialBoundary(node.text)) owner.credential = true;
      ts.forEachChild(node, (child) => visit(child, owner, node));
    };
    visit(sourceFile, moduleOwner, null);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const owner of owners.values()) {
      if (owner.persistent || owner.declarationName === '<module>') continue;
      const prefix = owner.reference.slice(0, owner.reference.lastIndexOf('#') + 1);
      for (const called of owner.calledNames) {
        if (PERSISTENCE_HELPER.test(called) && owners.get(`${prefix}${called}`)?.persistent) {
          owner.persistent = true;
          changed = true;
          break;
        }
      }
    }
  }

  const persistence = [...owners.values()].filter((owner) => owner.persistent).map((owner) => owner.reference).sort();
  const credentials = [...owners.values()].filter((owner) => owner.credential).map((owner) => owner.reference.replace(/^persist:/u, 'credential:')).sort();
  const semantics = new Map([...owners.values()].filter((owner) => owner.persistent || owner.credential).map((owner) => [owner.reference, owner.semanticSource.replace(/\s+/gu, ' ').trim()]));
  return { persistenceReferences: persistence, credentialReferences: credentials, sourceSymbols, semantics };
}
