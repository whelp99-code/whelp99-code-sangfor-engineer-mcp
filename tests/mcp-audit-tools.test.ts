import { beforeAll, describe, expect, it } from 'vitest';

process.env.MCP_NO_SERVE = '1';

const AUDIT_TOOL_NAMES = ['sangfor_audit_frameworks', 'sangfor_audit_checklist', 'sangfor_audit_gap_report'] as const;

let listTools: () => Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const module = await import('../apps/mcp-server/src/index.js');
  listTools = module.listTools as typeof listTools;
  getToolHandler = module.getToolHandler as typeof getToolHandler;
});

describe('audit checklist MCP surface — annotations', () => {
  it('all three tools are read-only, non-destructive (advisor-visible)', () => {
    const byName = new Map(listTools().map((t) => [t.name, t]));
    for (const name of AUDIT_TOOL_NAMES) {
      const tool = byName.get(name);
      expect(tool, name).toBeTruthy();
      expect(tool!.annotations.readOnlyHint, name).toBe(true);
      expect(tool!.annotations.destructiveHint, name).toBe(false);
    }
  });
});

describe('sangfor_audit_frameworks', () => {
  it('lists the seeded hyundai-supplier-2026 framework with its item count', () => {
    const result = getToolHandler('sangfor_audit_frameworks')!({}) as Array<{ frameworkId: string; itemCount: number }>;
    const hyundai = result.find((f) => f.frameworkId === 'hyundai-supplier-2026');
    expect(hyundai).toBeTruthy();
    expect(hyundai!.itemCount).toBe(35);
  });
});

describe('sangfor_audit_checklist', () => {
  const handler = () => getToolHandler('sangfor_audit_checklist')!;

  it('returns an error for an unregistered frameworkId', () => {
    const result = handler()({ frameworkId: 'does-not-exist' }) as { error?: string };
    expect(result.error).toMatch(/UNKNOWN_FRAMEWORK/);
  });

  it('returns the full filtered list, itemId-sorted, when cursor/limit are omitted (backward-compatible default)', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026' }) as { items: Array<{ itemId: string }> };
    expect(result.items).toHaveLength(35);
    expect(result.items[0].itemId).toBe('ITEM-01');
    expect(result.items.at(-1)!.itemId).toBe('ITEM-35');
    expect((result as any).nextCursor).toBeUndefined();
  });

  it('filters by group', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026', group: 'G6' }) as { items: Array<{ group: string }> };
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.group === 'G6')).toBe(true);
  });

  it('filters by product', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026', product: 'ENDPOINT_SECURE' }) as { items: Array<{ products: string[] }> };
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.products.includes('ENDPOINT_SECURE'))).toBe(true);
  });

  it('filters by priority', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026', priority: 'P3' }) as { items: Array<{ priority: string }> };
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.priority === 'P3')).toBe(true);
  });

  it('combined filters (group + owner) narrow further', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026', group: 'G2', owner: 'customer' }) as { items: Array<{ group: string; owner: string }> };
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.group === 'G2' && i.owner === 'customer')).toBe(true);
  });

  it('paginates with limit and hands back a nextCursor that continues the same filtered/sorted set', () => {
    const page1 = handler()({ frameworkId: 'hyundai-supplier-2026', limit: 10 }) as { items: Array<{ itemId: string }>; nextCursor?: string };
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = handler()({ frameworkId: 'hyundai-supplier-2026', limit: 10, cursor: page1.nextCursor }) as { items: Array<{ itemId: string }>; nextCursor?: string };
    expect(page2.items).toHaveLength(10);
    // no overlap between pages
    const ids1 = new Set(page1.items.map((i) => i.itemId));
    expect(page2.items.every((i) => !ids1.has(i.itemId))).toBe(true);

    const all = handler()({ frameworkId: 'hyundai-supplier-2026' }) as { items: Array<{ itemId: string }> };
    expect([...page1.items, ...page2.items].map((i) => i.itemId)).toEqual(all.items.slice(0, 20).map((i) => i.itemId));
  });
});

describe('sangfor_audit_gap_report', () => {
  const handler = () => getToolHandler('sangfor_audit_gap_report')!;

  it('returns an error for an unregistered frameworkId', () => {
    const result = handler()({ frameworkId: 'does-not-exist', observations: [] }) as { error?: string };
    expect(result.error).toMatch(/UNKNOWN_FRAMEWORK/);
  });

  it('includes every framework item even with zero observations, marked unknown/미확인 (never hides missing coverage)', () => {
    const result = handler()({ frameworkId: 'hyundai-supplier-2026', observations: [] }) as {
      items: Array<{ itemId: string; status: string; verdict: string; missingEvidence: string[] }>;
      summary: { total: number; unknown: number; observedRatio: number; metRatio: number };
    };
    expect(result.items).toHaveLength(35);
    expect(result.items.every((i) => i.status === 'unknown' && i.verdict === '미확인')).toBe(true);
    expect(result.items.every((i) => i.missingEvidence.length > 0)).toBe(true);
    expect(result.summary).toEqual({ total: 35, met: 0, partial: 0, gap: 0, unknown: 35, observedRatio: 0, metRatio: 0 });
  });

  it('maps met/partial/gap/unknown statuses to O/△/X/미확인 verdicts and computes missingEvidence + summary correctly', () => {
    const result = handler()({
      frameworkId: 'hyundai-supplier-2026',
      observations: [
        { itemId: 'ITEM-08', status: 'partial', observed: 'EPP 로그 보존 180일 (365일 요구 미달)', evidenceRefs: ['EPP LoggingOptions 캡처'] },
        { itemId: 'ITEM-04', status: 'gap', observed: 'EPP 비관리 단말 다수 확인' },
        { itemId: 'ITEM-02', status: 'met', observed: 'syslog 수집기 가동 확인', evidenceRefs: ['수집 소스 목록 캡처', '로그 수신 확인 캡처'] },
      ],
    }) as {
      items: Array<{ itemId: string; status: string; verdict: string; missingEvidence: string[]; evidenceRefs?: string[] }>;
      summary: { total: number; met: number; partial: number; gap: number; unknown: number; observedRatio: number; metRatio: number };
    };

    const byId = new Map(result.items.map((i) => [i.itemId, i]));
    expect(byId.get('ITEM-08')!.verdict).toBe('△');
    expect(byId.get('ITEM-08')!.missingEvidence).toEqual([]);
    expect(byId.get('ITEM-04')!.verdict).toBe('X');
    // no evidenceRefs supplied for ITEM-04 → all requiredEvidence reported missing
    expect(byId.get('ITEM-04')!.missingEvidence.length).toBeGreaterThan(0);
    expect(byId.get('ITEM-02')!.verdict).toBe('O');
    expect(byId.get('ITEM-02')!.missingEvidence).toEqual([]);

    // every other item has no observation → unknown/미확인
    const unmentioned = result.items.filter((i) => !['ITEM-08', 'ITEM-04', 'ITEM-02'].includes(i.itemId));
    expect(unmentioned.every((i) => i.status === 'unknown' && i.verdict === '미확인')).toBe(true);

    // R1: observedRatio (inspection progress) and metRatio (pass rate) are distinct —
    // 3 of 35 items have any observation at all (observedRatio), only 1 of 35 is fully met (metRatio).
    expect(result.summary).toEqual({ total: 35, met: 1, partial: 1, gap: 1, unknown: 32, observedRatio: 3 / 35, metRatio: 1 / 35 });
    expect(result.summary.observedRatio).not.toBe(result.summary.metRatio);
  });
});
