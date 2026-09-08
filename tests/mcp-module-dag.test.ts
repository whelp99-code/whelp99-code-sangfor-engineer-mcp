import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRATION_ORDER } from '../apps/mcp-server/src/tool-registration-order.js';
import { listTools } from '../apps/mcp-server/src/tool-registry.js';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = join(ROOT, 'apps/mcp-server/src');
const REMOVED_MIXED_BUCKETS = [
  'discovery-tool-catalog.ts',
  'document-tool-catalog.ts',
  'hci-tool-catalog.ts',
  'operations-tool-catalog.ts',
  'planning-tool-catalog.ts',
  'tool-adapter-support.ts',
] as const;

function localImports(path: string): readonly string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('./')) return [];
    return [specifier.replace(/^\.\//u, '').replace(/\.js$/u, '.ts')];
  });
}

function cycles(graph: ReadonlyMap<string, readonly string[]>): readonly string[][] {
  const found: string[][] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (node: string): void => {
    const activeIndex = visiting.indexOf(node);
    if (activeIndex >= 0) {
      found.push([...visiting.slice(activeIndex), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.pop();
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return found;
}

describe('MCP module DAG and cohesion', () => {
  it('has zero local-import cycles and keeps registry as composition-only', () => {
    // Given every MCP production module and its local imports.
    const files = readdirSync(SOURCE_ROOT).filter((name) => name.endsWith('.ts')).sort();
    const graph = new Map(files.map((name) => [name, localImports(join(SOURCE_ROOT, name))]));

    // When the complete local module graph is traversed.
    const found = cycles(graph);

    // Then the graph is acyclic and the profile leaf never imports registry.
    expect(found).toEqual([]);
    expect(graph.get('tool-profile.ts')).not.toContain('tool-registry.ts');
    expect(graph.get('mcp-contracts.ts')).toEqual([]);
  });

  it('preserves the giant baseline registration names and exact hash preimage', () => {
    // Given the live composed registry and the names captured from the giant baseline.
    const names = listTools().map(({ name }) => name);
    const giantBaselineNames = [...TOOL_REGISTRATION_ORDER];

    // When the baseline contract uses JSON.stringify(names) exactly, without normalization.
    const baselinePreimage = JSON.stringify(names);
    const baselineDigest = createHash('sha256').update(baselinePreimage).digest('hex');
    const secondaryNewlinePreimage = names.join('\n');
    const secondaryNewlineDigest = createHash('sha256').update(secondaryNewlinePreimage).digest('hex');

    // Then array equality is primary and any future preimage normalization change fails explicitly.
    expect(names).toEqual(giantBaselineNames);
    expect(names).toHaveLength(118);
    expect(baselineDigest).toBe('a3448ac4a4e1206485a67db782ba6f2ea15007c4b3401c9d36900ba0c6154b2b');
    expect(secondaryNewlineDigest).toBe('6ff0994780be9bf4fd3feb1621418b5a11dfa3b0ca6c083c7d9694fcea2633d6');
  });

  it('replaces mixed buckets with cohesive domain owners', () => {
    // Given the release module census.
    const names = readdirSync(SOURCE_ROOT);

    // When old mixed buckets and required cohesive owners are compared.
    // Then no arbitrary mixed bucket remains and each reviewed domain has an owner.
    for (const removed of REMOVED_MIXED_BUCKETS) expect(names).not.toContain(removed);
    expect(names).toEqual(expect.arrayContaining([
      'audit-tool-catalog.ts',
      'manifest-tool-catalog.ts',
      'observability-tool-catalog.ts',
      'office-tool-catalog.ts',
      'capture-tool-catalog.ts',
      'inventory-analysis-tool-catalog.ts',
      'advisory-tool-catalog.ts',
      'pm-tool-catalog.ts',
      'planner-tool-catalog.ts',
      'operator-session-tool-catalog.ts',
      'feedback-tool-catalog.ts',
      'spec-tool-catalog.ts',
      'hci-read-tool-catalog.ts',
      'hci-mutation-tool-catalog.ts',
    ]));
  });
});
