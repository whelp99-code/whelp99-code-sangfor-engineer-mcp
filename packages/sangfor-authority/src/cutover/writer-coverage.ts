import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { AUTHORITY_MANIFEST } from '../migration-manifest.js';
import { AuthorityCutoverError } from './errors.js';

export const LOCAL_WRITER_REFS = [
  'persist:apps/control-tower/src/playbook-store.ts#PlaybookStore', 'persist:apps/control-tower/src/registry.ts#Registry',
  'persist:apps/control-tower/src/playbook-store.ts#AnalysisStore', 'persist:packages/sangfor-runs/src/run-store.ts#RunStore',
  'persist:packages/sangfor-approval/src/index.ts#FileSingleUseNonceStore', 'persist:packages/sangfor-hci-client/src/audit-ledger.ts#AuditLedger',
  'persist:packages/sangfor-engineer-report/src/ledger.ts#appendEngineerReport', 'persist:apps/control-tower/src/playbook-store.ts#AgentTaskStore',
  'persist:packages/sangfor-feedback/src/index.ts#submitFeedback', 'persist:packages/sangfor-feedback/src/index.ts#extractLesson',
  'persist:packages/sangfor-evals/src/index.ts#createEvalCaseFromFeedback', 'persist:packages/sangfor-wiki/src/index.ts#ObsidianVaultAdapter',
  'persist:packages/sangfor-wiki/src/index.ts#GitHubWikiGitAdapter', 'persist:packages/sangfor-wiki/src/index.ts#upsertKnowledgeCard',
  'persist:packages/sangfor-wiki/src/index.ts#proposeWikiUpdate', 'persist:packages/sangfor-wiki/src/index.ts#approveWikiUpdate',
  'persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdateWithAdapter', 'persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdate',
  'persist:packages/sangfor-learning-strategy/src/store.ts#StrategyStoreManager', 'persist:packages/sangfor-chronicle/src/store.ts#recordSnapshot',
  'persist:packages/sangfor-competency/src/promotion-checkpoint.ts#initializePromotionStore',
  'persist:packages/sangfor-competency/src/promotion-ledger.ts#FilePromotionLedger',
] as const;
const INTERNAL_LOCAL_HELPERS = new Set([
  'persist:packages/sangfor-wiki/src/index.ts#saveCard', 'persist:packages/sangfor-wiki/src/index.ts#saveProposal',
  'persist:packages/sangfor-learning-strategy/src/store.ts#writeFileAtomic',
  'persist:packages/sangfor-competency/src/promotion-checkpoint.ts#writePromotionCheckpoint',
  // Module-private descriptor writer used only by the already-fenced
  // FileSingleUseNonceStore; it is not a separate writer entry point.
  'persist:packages/sangfor-approval/src/index.ts#writeFileDescriptor',
]);

function symbolNode(source: ts.SourceFile, name: string): ts.Node | undefined {
  return source.statements.find((node) => ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name)));
}
function isFenceCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'write' && ts.isPropertyAccessExpression(node.expression.expression)
    && node.expression.expression.name.text === 'fence';
}
function isObserved(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return Boolean(parent && (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)
    || (ts.isArrowFunction(parent) && parent.body === node)));
}
function validateFenceCalls(node: ts.Node, reference: string): void {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => { if (ts.isCallExpression(child) && isFenceCall(child)) calls.push(child); ts.forEachChild(child, visit); };
  visit(node);
  if (calls.length === 0) throw new AuthorityCutoverError('LOCAL_WRITER_UNGUARDED', [reference]);
  for (const call of calls) {
    const intent = call.arguments[1];
    if (call.arguments.length !== 3 || !intent || !ts.isObjectLiteralExpression(intent)
      || !intent.properties.some((property) => property.name !== undefined
        && ((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'targetPaths'))) {
      throw new AuthorityCutoverError('LOCAL_WRITER_INTENT_MISSING', [reference]);
    }
    if (!isObserved(call)) throw new AuthorityCutoverError('LOCAL_WRITER_PROMISE_IGNORED', [reference]);
  }
}

function verifyWriterCallers(root:string):void{
  const configPath=ts.findConfigFile(root,ts.sys.fileExists,'tsconfig.json');if(!configPath)throw new AuthorityCutoverError('LOCAL_WRITER_TSCONFIG_MISSING');
  const config=ts.parseJsonConfigFileContent(ts.readConfigFile(configPath,ts.sys.readFile).config,ts.sys,root);const program=ts.createProgram(config.fileNames,config.options);const checker=program.getTypeChecker();
  const writerNames=new Set(LOCAL_WRITER_REFS.map(ref=>ref.slice(ref.lastIndexOf('#')+1)));
  const declarationOwner=(node:ts.Node|undefined):string|undefined=>{let cursor=node;while(cursor){if((ts.isClassDeclaration(cursor)||ts.isFunctionDeclaration(cursor))&&cursor.name)return cursor.name.text;cursor=cursor.parent;}return undefined;};
  const observed=(call:ts.CallExpression):boolean=>{let node:ts.Node=call;while(node.parent&&(ts.isParenthesizedExpression(node.parent)||ts.isAsExpression(node.parent)))node=node.parent;if(ts.isPropertyAccessExpression(node.parent)&&node.parent.name.text==='catch')return false;if(ts.isAwaitExpression(node.parent)||ts.isReturnStatement(node.parent))return true;return ts.isArrowFunction(node.parent)&&node.parent.body===node;};
  for(const source of program.getSourceFiles()){
    if(source.isDeclarationFile||source.fileName.includes('/node_modules/')||source.fileName.includes('/tests/'))continue;
    const visit=(node:ts.Node):void=>{if(ts.isIdentifier(node)&&node.text==='explicitLocalPrimaryAuthority'&&ts.isCallExpression(node.parent)&&node.parent.expression===node&&!source.fileName.endsWith('/packages/shared/src/local-write-fence.ts'))throw new AuthorityCutoverError('EXPLICIT_LOCAL_COMPOSITION_FORBIDDEN',[source.fileName]);if(ts.isCallExpression(node)){
      const symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression)?node.expression.name:node.expression);const target=symbol?.valueDeclaration??symbol?.declarations?.[0];const owner=declarationOwner(target);
      if(owner&&writerNames.has(owner)&&checker.getTypeAtLocation(node).getProperty('then')&&!isFenceCall(node)&&!observed(node))throw new AuthorityCutoverError('LOCAL_WRITER_CALLER_PROMISE_IGNORED',[`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1}:${owner}`]);
    }ts.forEachChild(node,visit);};visit(source);
  }
}

export function verifyLocalWriterCoverage(root: string): void {
  const discovered = AUTHORITY_MANIFEST.entries.filter((entry) => entry.classification === 'authoritative')
    .flatMap((entry) => entry.inventoryRefs)
    .filter((reference) => reference.startsWith('persist:packages/') || reference.startsWith('persist:apps/'))
    .filter((reference) => !reference.startsWith('persist:packages/sangfor-authority/'))
    .filter((reference) => !reference.includes('postgres-nonce-store.ts'))
    .filter((reference) => !reference.startsWith('persist:packages/sangfor-rag/src/pgvector-store.ts#'))
    .filter((reference) => !INTERNAL_LOCAL_HELPERS.has(reference)).sort();
  const expected = [...LOCAL_WRITER_REFS].sort();
  if (discovered.join('\n') !== expected.join('\n')) throw new AuthorityCutoverError('LOCAL_WRITER_SET_DRIFT');
  for (const reference of LOCAL_WRITER_REFS) {
    const match = /^persist:(.+)#([^#]+)$/u.exec(reference);
    if (!match?.[1] || !match[2]) throw new AuthorityCutoverError('LOCAL_WRITER_REF_INVALID', [reference]);
    const path = resolve(root, match[1]);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const node = symbolNode(source, match[2]); if (!node) throw new AuthorityCutoverError('LOCAL_WRITER_RENAMED', [reference]);
    validateFenceCalls(node, reference);
  }
  verifyWriterCallers(root);
}
