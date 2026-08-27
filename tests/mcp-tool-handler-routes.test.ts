import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readMutatedCatalogRoutes,
  readToolRoutes,
  type ToolRoute,
} from './helpers/mcp-tool-route-reader.js';

const ROOT = resolve(import.meta.dirname, '..');
const ROUTE_FIXTURE = join(ROOT, 'tests/fixtures/mcp-tool-handler-routes-v1.json');

type RouteArtifact = {
  readonly schemaVersion: 'mcp-tool-handler-routes.v1';
  readonly baselineSource: string;
  readonly knownRouteCount: number;
  readonly routes: readonly ToolRoute[];
  readonly sha256: string;
};

function artifactDigest(artifact: Omit<RouteArtifact, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}

describe('MCP non-circular handler route lock', () => {
  it('matches all 118 AST-derived handler routes captured from the giant baseline', () => {
    // Given a reviewed artifact that normal tests never regenerate.
    const expected = JSON.parse(readFileSync(ROUTE_FIXTURE, 'utf8')) as RouteArtifact;

    // When current registrations are parsed directly from catalog ASTs.
    const actual = readToolRoutes(ROOT);
    const names = actual.map(({ toolName }) => toolName);

    // Then every unique handler expression and catalog owner remains locked.
    expect(expected.baselineSource).toBe('git:HEAD:apps/mcp-server/src/index.ts');
    expect(expected.knownRouteCount).toBe(118);
    expect(expected.sha256).toBe(artifactDigest({
      schemaVersion: expected.schemaVersion,
      baselineSource: expected.baselineSource,
      knownRouteCount: expected.knownRouteCount,
      routes: expected.routes,
    }));
    expect(actual).toEqual(expected.routes);
    expect(names).toHaveLength(118);
    expect(new Set(names).size).toBe(118);
  });

  it('catches the exact discoverProductConsole to collectProductConfig handler mutant', () => {
    // Given a source mutation that changes the real handler expression without metadata.
    const catalogFile = 'apps/mcp-server/src/product-read-tool-catalog.ts';
    const source = readFileSync(join(ROOT, catalogFile), 'utf8');
    const mutated = source.replace('handler: discoverProductConsole', 'handler: collectProductConfig');
    expect(mutated).not.toBe(source);

    // When routes are read from the mutated AST.
    const routes = readMutatedCatalogRoutes(ROOT, catalogFile, mutated);
    const route = routes.find(({ toolName }) => toolName === 'sangfor_discover_product_console');
    const expected = (JSON.parse(readFileSync(ROUTE_FIXTURE, 'utf8')) as RouteArtifact).routes
      .find(({ toolName }) => toolName === 'sangfor_discover_product_console');

    // Then the actual handler fingerprint changes and the route lock rejects it.
    expect(route).toBeDefined();
    expect(expected).toBeDefined();
    expect(route).not.toEqual(expected);
  });

  it('has no candidate-code fixture regeneration path', () => {
    // Given production and test source outside the immutable fixture.
    const sources = [
      readFileSync(join(ROOT, 'apps/mcp-server/src/tool-registry.ts'), 'utf8'),
      readFileSync(join(ROOT, 'tests/helpers/mcp-tool-route-reader.ts'), 'utf8'),
    ].join('\n');

    // When normal runtime/test code is inspected, then it contains no fixture writer.
    expect(sources).not.toContain('writeFileSync(ROUTE_FIXTURE');
    expect(sources).not.toContain('mcp-tool-handler-routes-v1.json`,');
  });
});
