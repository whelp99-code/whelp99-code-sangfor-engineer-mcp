import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readMutatedCatalogRoutes, readToolRoutes, type ToolRoute } from './helpers/mcp-tool-route-reader.js';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE_PATH = join(ROOT, 'tests/fixtures/mcp-tool-handler-routes-baseline-v1.json');
const REVIEW_PATH = join(ROOT, 'tests/fixtures/mcp-tool-handler-route-review-v1.json');
const routeSchema = z.object({ toolName: z.string(), handlerAstSha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const currentRouteSchema = routeSchema.extend({ catalogSource: z.string() });
const baselineSchema = z.object({
  schemaVersion: z.literal('mcp-tool-handler-routes-baseline.v1'),
  source: z.object({
    ref: z.literal('origin/main'),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    path: z.literal('apps/mcp-server/src/index.ts'),
  }),
  knownRouteCount: z.literal(115),
  routes: z.array(routeSchema).length(115),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const reviewSchema = z.object({
  schemaVersion: z.literal('mcp-tool-handler-route-review.v1'),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  baselineRouteCount: z.literal(115),
  finalRouteCount: z.literal(118),
  reviewedHandlerChanges: z.array(currentRouteSchema),
  approvedAdditions: z.array(currentRouteSchema).length(3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Baseline = z.infer<typeof baselineSchema>;
type Review = z.infer<typeof reviewSchema>;

type ComparableRoute = {
  readonly toolName: string;
  readonly catalogSource: string;
  readonly handlerAstSha256: string;
};

function fixtureDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function comparable(route: ToolRoute): ComparableRoute {
  return {
    toolName: route.toolName,
    catalogSource: route.catalogSource,
    handlerAstSha256: route.handlerAstSha256,
  };
}

function assertReviewedRoutes(actual: readonly ComparableRoute[], baseline: Baseline, review: Review): void {
  const actualByName = new Map(actual.map((route) => [route.toolName, route]));
  const changes = new Map(review.reviewedHandlerChanges.map((route) => [route.toolName, route]));
  const expectedNames = [...baseline.routes.map(({ toolName }) => toolName), ...review.approvedAdditions.map(({ toolName }) => toolName)].sort();
  expect(actual.map(({ toolName }) => toolName).sort()).toEqual(expectedNames);
  expect(new Set(expectedNames).size).toBe(review.finalRouteCount);
  for (const oldRoute of baseline.routes) {
    const actualRoute = actualByName.get(oldRoute.toolName);
    const changedRoute = changes.get(oldRoute.toolName);
    expect(actualRoute?.handlerAstSha256, oldRoute.toolName)
      .toBe(changedRoute?.handlerAstSha256 ?? oldRoute.handlerAstSha256);
    if (changedRoute !== undefined) expect(actualRoute?.catalogSource, oldRoute.toolName).toBe(changedRoute.catalogSource);
  }
  for (const addition of review.approvedAdditions) expect(actualByName.get(addition.toolName), addition.toolName).toEqual(addition);
}

const baseline = baselineSchema.parse(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')));
const review = reviewSchema.parse(JSON.parse(readFileSync(REVIEW_PATH, 'utf8')));

describe('MCP origin/main route baseline and reviewed route delta', () => {
  it('preserves every baseline route and adds only the three reviewed IAG routes', () => {
    const actual = readToolRoutes(ROOT).map(comparable);
    assertReviewedRoutes(actual, baseline, review);
  });

  it('rejects a removed or changed old route and an unexpected fourth route', () => {
    const actual = readToolRoutes(ROOT).map(comparable);
    const oldName = baseline.routes[0]?.toolName;
    const removed = actual.filter(({ toolName }) => toolName !== oldName);
    const changed = actual.map((route) => route.toolName === oldName
      ? { ...route, handlerAstSha256: '0'.repeat(64) }
      : route);
    const added = [...actual, {
      toolName: 'sangfor_iag_unreviewed_fourth_tool',
      catalogSource: 'apps/mcp-server/src/iag-orchestrator-tools.ts',
      handlerAstSha256: '1'.repeat(64),
    }];

    expect(() => assertReviewedRoutes(removed, baseline, review)).toThrow();
    expect(() => assertReviewedRoutes(changed, baseline, review)).toThrow();
    expect(() => assertReviewedRoutes(added, baseline, review)).toThrow();
  });

  it('catches the discoverProductConsole handler mutant', () => {
    const catalogFile = 'apps/mcp-server/src/product-read-tool-catalog.ts';
    const source = readFileSync(join(ROOT, catalogFile), 'utf8');
    const mutated = source.replace('handler: discoverProductConsole', 'handler: collectProductConfig');
    const routes = readMutatedCatalogRoutes(ROOT, catalogFile, mutated).map(comparable);
    const original = readToolRoutes(ROOT).map(comparable)
      .filter(({ catalogSource }) => catalogSource !== catalogFile);

    expect(mutated).not.toBe(source);
    expect(() => assertReviewedRoutes([...original, ...routes], baseline, review)).toThrow();
  });

  it('authenticates the origin baseline and reviewed delta independently', () => {
    const { sha256: baselineDigest, ...baselinePayload } = baseline;
    const { sha256: reviewDigest, ...reviewPayload } = review;
    expect(fixtureDigest(baselinePayload)).toBe(baselineDigest);
    expect(fixtureDigest(reviewPayload)).toBe(reviewDigest);
    expect(review.baselineCommit).toBe(baseline.source.commit);
    expect(review.reviewedHandlerChanges.map(({ toolName }) => toolName).sort())
      .toEqual([...new Set(review.reviewedHandlerChanges.map(({ toolName }) => toolName))].sort());
  });
});
