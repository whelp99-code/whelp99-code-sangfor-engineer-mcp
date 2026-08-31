import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testLocalWriteAuthority } from './helpers/local-write-authority.js';
import * as playbookStore from '../apps/control-tower/src/playbook-store.js';
import { PlaybookStore, type PlaybookBlock } from '../apps/control-tower/src/playbook-store.js';

const SRC = resolve(import.meta.dirname, '../apps/control-tower/src');
const SIZE_CEILING = 250;
const DECOMPOSED_MODULES = [
  'playbook-review.ts',
  'playbook-store.ts',
  'playbook-types.ts',
  'playbook-validation.ts',
] as const;
const STORE_MODULE = 'playbook-store.ts';
const INVENTORIED_PARSERS = [
  'parseBoundaryControlTowerAgentTasksV1',
  'parseBoundaryControlTowerAnalysisLineV1',
  'parseBoundaryControlTowerPlaybooksV1',
] as const;
const EXPECTED_RUNTIME_EXPORTS = [
  'AgentTaskStore',
  'AnalysisStore',
  'PlaybookStore',
  'PlaybookValidationError',
  'validateBlocks',
] as const;
const EXPECTED_DECLARED_EXPORTS = [
  'AgentTask',
  'AgentTaskKind',
  'AgentTaskStore',
  'AnalysisImprovement',
  'AnalysisProposal',
  'AnalysisStore',
  'AnalysisVerdict',
  'Playbook',
  'PlaybookAnalysis',
  'PlaybookBlock',
  'PlaybookRevision',
  'PlaybookStore',
  'PlaybookValidationError',
  'validateBlocks',
] as const;
const BLOCKS: PlaybookBlock[] = [{ id: 'b1', type: 'tool', toolId: 'sangfor_advisor_fortios_advanced' }];

function moduleSource(name: string): string {
  return readFileSync(join(SRC, name), 'utf8');
}

function pureLineCount(source: string): number {
  return source.split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'))
    .length;
}

function parseModule(name: string): ts.SourceFile {
  return ts.createSourceFile(join(SRC, name), moduleSource(name), ts.ScriptTarget.Latest, true);
}

function collect(source: ts.SourceFile, take: (node: ts.Node) => string | undefined): readonly string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const hit = take(node);
    if (hit !== undefined) found.push(hit);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function nonNullAssertions(name: string): readonly string[] {
  const source = parseModule(name);
  return collect(source, (node) => (ts.isNonNullExpression(node)
    ? `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    : undefined));
}

function strictParserCalls(name: string): readonly string[] {
  const source = parseModule(name);
  return collect(source, (node) => (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text.startsWith('parseBoundary')
    ? node.expression.text
    : undefined));
}

function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) return statement.name?.text;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  return undefined;
}

function declaredExports(name: string): readonly string[] {
  const source = parseModule(name);
  const names: string[] = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    const declared = exported ? declarationName(statement) : undefined;
    if (declared !== undefined) names.push(declared);
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
  }
  return names.sort();
}

describe('control-tower playbook module decomposition', () => {
  it('keeps every decomposed playbook module below the source-module size ceiling', () => {
    // Given the modules the playbook domain is decomposed into.
    const sizes = DECOMPOSED_MODULES.map((name) => [name, pureLineCount(moduleSource(name))] as const);

    // When pure source lines are counted without blank or line-comment-only lines.
    const oversized = sizes.filter(([, lines]) => lines >= SIZE_CEILING);

    // Then every module stays inside a single reviewer's working memory.
    expect(oversized).toEqual([]);
  });

  it('discriminates the review verdict without any non-null assertion', () => {
    // Given every decomposed playbook module.
    // When their syntax trees are scanned for postfix non-null assertions.
    const assertions = DECOMPOSED_MODULES.flatMap((name) => nonNullAssertions(name));

    // Then no module papers over a contract the type system should prove.
    expect(assertions).toEqual([]);
  });

  it('keeps every inventoried strict parser call inside the store module', () => {
    // Given the strict runtime-boundary parsers the inventory pins to the store module.
    const inStore = [...strictParserCalls(STORE_MODULE)].sort();
    const elsewhere = DECOMPOSED_MODULES
      .filter((name) => name !== STORE_MODULE)
      .flatMap((name) => strictParserCalls(name));

    // When the decomposition moves code out of the store module.
    // Then each inventoried parser is still called exactly once, and only there.
    expect(inStore).toEqual([...INVENTORIED_PARSERS]);
    expect(elsewhere).toEqual([]);
  });

  it('preserves the declared and runtime export surface of the store module', () => {
    // Given the public API every caller and the runtime-boundary codec module import.
    // When the store module's static declarations and runtime keys are inspected.
    const declared = declaredExports(STORE_MODULE);
    const runtime = Object.keys(playbookStore).sort();

    // Then type-only and runtime consumers keep exactly the same names.
    expect(declared).toEqual([...EXPECTED_DECLARED_EXPORTS].sort());
    expect(runtime).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it('parses a padded rejection into a typed verdict carrying a trimmed reason', async () => {
    // Given the extracted revision-review policy.
    const { parseReviewVerdict } = await import('../apps/control-tower/src/playbook-review.js');

    // When a rejection with surrounding whitespace is parsed.
    const decision = parseReviewVerdict({ approve: false, reviewedBy: 'jmpark', rejectReason: '  HA 누락  ' });

    // Then the reject reason is proven present by the type, not by an assertion.
    expect(decision).toEqual({ approve: false, reviewedBy: 'jmpark', rejectReason: 'HA 누락' });
  });
});

describe('playbook revision review behavior', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-review-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function store(): PlaybookStore {
    return new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
  }

  it('stores the trimmed reject reason and the reviewer verbatim', async () => {
    // Given a draft revision awaiting review.
    const reviews = store();
    const pb = await reviews.create({ name: 'x', goal: 'g', blocks: BLOCKS, authoredBy: 'a' });

    // When it is rejected with a padded reason.
    const rejected = await reviews.reviewRevision(pb.id, 1, { approve: false, reviewedBy: 'jmpark', rejectReason: '  HA 누락  ' });

    // Then the reason is trimmed while the reviewer identity is stored untouched.
    expect(rejected.revisions[0]).toMatchObject({ status: 'rejected', reviewedBy: 'jmpark', rejectReason: 'HA 누락' });
  });

  it('leaves an approved revision without any reject reason', async () => {
    // Given a draft revision awaiting review.
    const reviews = store();
    const pb = await reviews.create({ name: 'x', goal: 'g', blocks: BLOCKS, authoredBy: 'a' });

    // When it is approved by a reviewer whose name carries padding.
    const approved = await reviews.reviewRevision(pb.id, 1, { approve: true, reviewedBy: '  jmpark  ' });

    // Then approval records the reviewer verbatim and writes no rejection reason.
    expect(approved.revisions[0].status).toBe('approved');
    expect(approved.revisions[0].reviewedBy).toBe('  jmpark  ');
    expect(approved.revisions[0].rejectReason).toBeUndefined();
  });

  it('reports a non-draft revision before it validates the verdict', async () => {
    // Given a revision that has already been approved.
    const reviews = store();
    const pb = await reviews.create({ name: 'x', goal: 'g', blocks: BLOCKS, authoredBy: 'a' });
    await reviews.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });

    // When it is reviewed again with a verdict that is itself malformed.
    const replay = reviews.reviewRevision(pb.id, 1, { approve: false, reviewedBy: '   ' });

    // Then the state-machine violation wins over the verdict validation.
    await expect(replay).rejects.toThrow(expect.objectContaining({ status: 409 }));
  });

  it('refuses a rejection that names no reason and a review that names no reviewer', async () => {
    // Given two draft revisions awaiting review.
    const reviews = store();
    const pb = await reviews.create({ name: 'x', goal: 'g', blocks: BLOCKS, authoredBy: 'a' });

    // When the verdict omits the reviewer, then when a rejection omits its reason.
    const anonymous = reviews.reviewRevision(pb.id, 1, { approve: true, reviewedBy: '  ' });
    const unexplained = reviews.reviewRevision(pb.id, 1, { approve: false, reviewedBy: 'jmpark', rejectReason: '  ' });

    // Then each is refused as a client error with its own message.
    await expect(anonymous).rejects.toThrow(/reviewedBy는 필수입니다/);
    await expect(unexplained).rejects.toThrow(/반려 사유\(rejectReason\)는 필수입니다/);
    await expect(unexplained).rejects.toThrow(expect.objectContaining({ status: 400 }));
  });
});
