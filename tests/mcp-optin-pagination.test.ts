import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mod.getToolHandler as typeof getToolHandler;
});

describe('sangfor_list_spec_coverage — opt-in cursor pagination (C4)', () => {
  it('with neither cursor nor limit, returns the full coverage array unchanged (backward-compat)', () => {
    const handler = getToolHandler('sangfor_list_spec_coverage')!;
    const result: any = handler({});
    expect(Array.isArray(result.coverage)).toBe(true);
    expect(result.coverage.length).toBeGreaterThan(1);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('pages through the full set with no duplicates or gaps when a limit is supplied', () => {
    const handler = getToolHandler('sangfor_list_spec_coverage')!;
    const full: any = handler({});
    const key = (c: any) => `${c.product}::${c.version}`;

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page: any = handler({ cursor, limit: 3 });
      expect(page.coverage.length).toBeLessThanOrEqual(3);
      collected.push(...page.coverage.map(key));
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual(full.coverage.map(key));
  });

  it('rejects a cursor that does not identify a row in the result set', () => {
    const handler = getToolHandler('sangfor_list_spec_coverage')!;
    expect(() => handler({ cursor: 'bm9wZQ', limit: 3 })).toThrow('INVALID_CURSOR');
  });
});

describe('sangfor_field_engineer_coverage — opt-in cursor pagination over atoms (C4)', () => {
  // Pagination is the behavior under test, so the catalog must be one that
  // actually validates: the committed catalog carries a known evidence defect
  // and (correctly) refuses to produce a report at all, which would test the
  // fail-closed path instead of the cursor contract.
  const fixtureRoots: string[] = [];
  let previousCatalogRoot: string | undefined;
  let previousOutputRoot: string | undefined;

  beforeAll(() => {
    const catalogRoot = mkdtempSync(join(tmpdir(), 'mcp-paging-catalog-'));
    const outputRoot = mkdtempSync(join(tmpdir(), 'mcp-paging-output-'));
    fixtureRoots.push(catalogRoot, outputRoot);
    writeFileSync(join(outputRoot, 'capture.md'), '# real capture\n');
    // The policy ships beside the atoms, exactly as data/competency does, so the
    // one field_verified claim in this fixture binds to a declared capability.
    writeFileSync(join(catalogRoot, 'capability-maturity.json'), JSON.stringify({
      version: 1,
      entries: [{ product: 'EPP', capabilityId: 'cap.health', maturity: 'field_verified' }],
    }));
    writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({
      version: 1,
      atoms: Array.from({ length: 20 }, (_unused, index) => ({
        id: `atom_${String(index).padStart(2, '0')}`,
        product: 'EPP',
        phase: 'operate',
        title: `atom ${index}`,
        automatability: index % 5 === 0 ? 'human' : 'auto',
        ...(index % 5 === 0 ? { humanReason: 'physical' } : {}),
        coveredBy: index % 5 === 0 ? null : 'sangfor_evaluate_config',
        maturity: index === 1 ? 'field_verified' : 'planned',
        evidence: index === 1 ? 'capture.md' : null,
        ...(index === 1 ? { capabilityRef: { product: 'EPP', capabilityId: 'cap.health' } } : {}),
      })),
    }));

    previousCatalogRoot = process.env.SANGFOR_COMPETENCY_ROOT;
    previousOutputRoot = process.env.SANGFOR_OUTPUT_ROOT;
    process.env.SANGFOR_COMPETENCY_ROOT = catalogRoot;
    process.env.SANGFOR_OUTPUT_ROOT = outputRoot;
  });

  afterAll(() => {
    if (previousCatalogRoot === undefined) delete process.env.SANGFOR_COMPETENCY_ROOT;
    else process.env.SANGFOR_COMPETENCY_ROOT = previousCatalogRoot;
    if (previousOutputRoot === undefined) delete process.env.SANGFOR_OUTPUT_ROOT;
    else process.env.SANGFOR_OUTPUT_ROOT = previousOutputRoot;
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('with neither cursor nor limit, returns the full atoms array unchanged (backward-compat)', () => {
    const handler = getToolHandler('sangfor_field_engineer_coverage')!;
    const result: any = handler({});
    expect(Array.isArray(result.atoms)).toBe(true);
    expect(result.atoms.length).toBeGreaterThan(1);
    expect(result.coverage).toBeDefined();
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('coverage is computed over the FULL atom set regardless of pagination window', () => {
    const handler = getToolHandler('sangfor_field_engineer_coverage')!;
    const full: any = handler({});
    const paged: any = handler({ limit: 2 });
    expect(paged.coverage).toEqual(full.coverage);
    expect(paged.atoms.length).toBe(2);
  });

  it('pages through the full atoms list with no duplicates or gaps', () => {
    const handler = getToolHandler('sangfor_field_engineer_coverage')!;
    const full: any = handler({});
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page: any = handler({ cursor, limit: 8 });
      collected.push(...page.atoms.map((a: any) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toEqual(full.atoms.map((a: any) => a.id));
  });

  it('rejects a cursor that does not identify a row in the result set', () => {
    const handler = getToolHandler('sangfor_field_engineer_coverage')!;
    expect(() => handler({ cursor: 'bm9wZQ', limit: 2 })).toThrow('INVALID_CURSOR');
  });
});

describe('sangfor_pm_events — opt-in cursor pagination over the event timeline (C4)', () => {
  function seedEngagement(customer: string, eventCount: number): string {
    const createEngagement = getToolHandler('sangfor_pm_create_engagement')!;
    const addWorkItem = getToolHandler('sangfor_pm_add_work_item')!;
    const engagement: any = createEngagement({ customer, product: 'IAG' });
    for (let i = 0; i < eventCount; i++) addWorkItem({ engagementId: engagement.id, title: `work item ${i}` });
    return engagement.id;
  }

  it('with neither cursor nor limit, returns the full event timeline unchanged (backward-compat)', () => {
    const engagementId = seedEngagement('W1-Pagination-Backcompat', 3);
    const handler = getToolHandler('sangfor_pm_events')!;
    const result: any = handler({ engagementId });
    expect(result.events).toHaveLength(3);
    expect(result.chainOk.ok).toBe(true);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('pages through the full timeline with no duplicates or gaps when a limit is supplied', () => {
    const engagementId = seedEngagement('W1-Pagination-Pages', 5);
    const handler = getToolHandler('sangfor_pm_events')!;
    const full: any = handler({ engagementId });

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page: any = handler({ engagementId, cursor, limit: 2 });
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(page.chainOk.ok).toBe(true);
      collected.push(...page.events.map((e: any) => e.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual(full.events.map((e: any) => e.id));
  });

  it('rejects a cursor that does not identify a row in the result set', () => {
    const engagementId = seedEngagement('W1-Pagination-BadCursor', 2);
    const handler = getToolHandler('sangfor_pm_events')!;
    expect(() => handler({ engagementId, cursor: 'bm9wZQ', limit: 1 })).toThrow('INVALID_CURSOR');
  });

  it('still errors on an unknown engagement before any pagination logic runs', () => {
    const handler = getToolHandler('sangfor_pm_events')!;
    expect(() => handler({ engagementId: 'eng_does_not_exist', limit: 1 })).toThrow(/not found/i);
  });
});
