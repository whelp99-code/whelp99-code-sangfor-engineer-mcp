import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { WIKI_REFS } from '../packages/sangfor-authority/src/migration-inventory-domains.js';
import { CREDENTIAL_REFS } from '../packages/sangfor-authority/src/migration-inventory-local.js';
import * as wiki from '../packages/sangfor-wiki/src/index.js';

const ROOT = join(import.meta.dirname, '..');
const BARREL = 'packages/sangfor-wiki/src/index.ts';

const WIKI_MODULES = [
  BARREL,
  'packages/sangfor-wiki/src/wiki-types.ts',
  'packages/sangfor-wiki/src/wiki-seed.ts',
  'packages/sangfor-wiki/src/wiki-store.ts',
  'packages/sangfor-wiki/src/wiki-search.ts',
  'packages/sangfor-wiki/src/wiki-write-compat.ts',
  'packages/sangfor-wiki/src/runtime-codecs.ts',
] as const;

const PUBLIC_SURFACE = [
  'ObsidianVaultAdapter',
  'GitHubWikiGitAdapter',
  'applyGitHubWikiUpdate',
  'applyGitHubWikiUpdateWithAuthority',
  'applyObsidianWikiUpdate',
  'applyObsidianWikiUpdateWithAuthority',
  'applyWikiUpdate',
  'applyWikiUpdateWithAdapter',
  'applyWikiUpdateWithAdapterAndAuthority',
  'applyWikiUpdateWithAuthority',
  'approveWikiUpdate',
  'approveWikiUpdateWithAuthority',
  'listKnowledgeCards',
  'listSeedWiki',
  'mintWikiApproval',
  'proposeWikiUpdate',
  'proposeWikiUpdateWithAuthority',
  'searchWiki',
  'upsertKnowledgeCard',
  'upsertKnowledgeCardWithAuthority',
] as const;

function pureLineCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

/** Symbols the authority census pins to the barrel path, derived from the lock's inventories. */
function barrelPinnedSymbols(): readonly string[] {
  const refs = [...WIKI_REFS, ...CREDENTIAL_REFS];
  const pinned = refs.flatMap((reference) => {
    const match = new RegExp(`^(?:persist|credential):${BARREL}#([^#]+)$`, 'u').exec(reference);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return [...new Set(pinned)].sort();
}

function topLevelDeclarationNames(path: string): ReadonlySet<string> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

describe('wiki module boundaries', () => {
  it('keeps every wiki module within the reviewable size limit', () => {
    // Given the declared wiki module set.
    // When each module's pure line count is measured.
    const oversized = WIKI_MODULES.flatMap((relativePath) => {
      const path = join(ROOT, relativePath);
      if (!existsSync(path)) return [`${basename(path)}:missing`];
      const lines = pureLineCount(readFileSync(path, 'utf8'));
      return lines > 250 ? [`${basename(path)}:${String(lines)}`] : [];
    });

    // Then no module exceeds the limit and none is missing.
    expect(oversized).toEqual([]);
  });

  it('exports the whole public wiki surface from the barrel', () => {
    // Given the barrel module namespace.
    // When its runtime export names are collected.
    const exported = Object.keys(wiki).sort();

    // Then the locked public surface is present in full.
    expect(exported).toEqual([...PUBLIC_SURFACE].sort());
  });

  it('declares every authority-pinned writer inside the barrel module itself', () => {
    // Given the writer and credential symbols the authority lock pins to the barrel path.
    const pinned = barrelPinnedSymbols();
    expect(pinned.length).toBeGreaterThan(0);

    // When the barrel's own top-level declarations are parsed.
    const declared = topLevelDeclarationNames(join(ROOT, BARREL));

    // Then each pinned symbol is declared there, not re-exported from a submodule.
    expect(pinned.filter((symbol) => !declared.has(symbol))).toEqual([]);
  });
});
