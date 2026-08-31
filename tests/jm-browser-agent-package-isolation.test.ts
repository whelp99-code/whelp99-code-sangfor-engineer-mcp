import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'apps/jm-browser-agent');

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
};

describe('JM browser agent package isolation', () => {
  it('declares jm-execution as a direct workspace dependency', () => {
    // Given the independently deployable app manifest.
    const manifest: PackageManifest = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );

    // Then its production execution package is a direct workspace edge.
    expect(manifest.dependencies?.['@sangfor/jm-execution']).toBe('workspace:*');
  });

  it('imports jm-execution through its package entry point', () => {
    // Given the operated production composition module.
    const path = join(APP_ROOT, 'src/operated-execution.ts');
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // Then package resolution, not repository-relative source layout, owns the edge.
    expect(specifiers).toContain('@sangfor/jm-execution');
    expect(specifiers.filter((specifier) => specifier.includes('sangfor-jm-execution'))).toEqual([]);
  });
});
