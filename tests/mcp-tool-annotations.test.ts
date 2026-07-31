import { beforeAll, describe, expect, it } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let listTools: () => Array<{ name: string; annotations?: any; category?: string }>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listTools = (mod as any).listTools;
});

describe('MCP tool annotations (readOnly/destructive hints) — fail-closed', () => {
  it('every tool carries boolean readOnly/destructive hints + a category + title', () => {
    for (const t of listTools()) {
      expect(typeof t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe('boolean');
      expect(typeof t.annotations?.destructiveHint, `${t.name} destructiveHint`).toBe('boolean');
      expect(t.annotations?.title, `${t.name} title`).toBeTruthy();
      expect(t.category, `${t.name} category`).toBeTruthy();
    }
  });

  it('device/external mutators are marked destructive (readOnlyHint:false, destructiveHint:true)', () => {
    const mustBeDestructive = [
      'sangfor_apply_approved_product_change',
      'sangfor_execute_console_action_live',
    ];
    const byName = new Map(listTools().map((t) => [t.name, t]));
    for (const n of mustBeDestructive) {
      const t = byName.get(n);
      expect(t, n).toBeTruthy();
      expect(t!.annotations.destructiveHint, n).toBe(true);
      expect(t!.annotations.readOnlyHint, n).toBe(false);
    }
  });

  it('FAIL-CLOSED: any apply_* / execute_* tool must be classified destructive (no unlabeled mutator ships)', () => {
    for (const t of listTools()) {
      const bare = t.name.replace(/^sangfor_/, '');
      if (bare.startsWith('apply_') || bare.startsWith('execute_')) {
        expect(t.annotations.destructiveHint, `${t.name} is a mutator but not marked destructive`).toBe(true);
      }
    }
  });

  it('pure advisory/read tools are readOnly and never destructive', () => {
    const readOnly = [
      'sangfor_evaluate_config', 'sangfor_read_console_state', 'sangfor_list_spec_coverage',
      'sangfor_pm_status', 'sangfor_suggest_rca', 'sangfor_recommend_sizing',
      'sangfor_check_version', 'sangfor_search_manuals',
    ];
    const byName = new Map(listTools().map((t) => [t.name, t]));
    for (const n of readOnly) {
      const t = byName.get(n);
      expect(t, n).toBeTruthy();
      expect(t!.annotations.readOnlyHint, n).toBe(true);
      expect(t!.annotations.destructiveHint, n).toBe(false);
    }
  });
});
