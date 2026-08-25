import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateInventoryTruth,
  parseToolInventory,
  summarizeInventory,
  type DocumentedCountInput,
  type ToolInventory,
} from '../scripts/lib/mcp-inventory-truth.js';

process.env.MCP_NO_SERVE = '1';

let liveInventory: ToolInventory;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  liveInventory = parseToolInventory(JSON.stringify({ tools: mod.listTools() }));
});

function documented(count: number): DocumentedCountInput {
  return { kind: 'required', counts: [{ source: 'docs/START_HERE_TODAY.md', count }] };
}

describe('MCP inventory truth — live census characterization', () => {
  it('Given the live tool registry, When summarized, Then every tool carries boolean hints and the write set is derived', () => {
    const summary = summarizeInventory(liveInventory);

    expect(summary.total).toBe(liveInventory.tools.length);
    expect(summary.total).toBeGreaterThan(100);
    expect(summary.writeTools.length + summary.readOnlyTools.length).toBe(summary.total);
    expect(summary.destructiveTools.length).toBeGreaterThan(0);
    for (const name of summary.destructiveTools) {
      expect(summary.writeTools, `${name} must be in the write set`).toContain(name);
    }
  });

  it('Given the live census as its own documented input, When evaluated, Then there are zero violations', () => {
    const summary = summarizeInventory(liveInventory);

    const report = evaluateInventoryTruth(liveInventory, documented(summary.total));

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary.total).toBe(summary.total);
  });
});

describe('MCP inventory truth — violations', () => {
  const mutation = {
    name: 'sangfor_apply_approved_product_change',
    description: 'Apply an approved change',
    annotations: { title: 'Apply', readOnlyHint: false, destructiveHint: true },
    category: 'admin',
  } as const;
  const reader = {
    name: 'sangfor_evaluate_config',
    description: 'Evaluate a config',
    annotations: { title: 'Evaluate', readOnlyHint: true, destructiveHint: false },
    category: 'advisory',
  } as const;

  it('Given a documented count that lags the live census, When evaluated, Then documented_count_stale is reported', () => {
    const inventory: ToolInventory = { tools: [mutation, reader] };

    const report = evaluateInventoryTruth(inventory, documented(108));

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual({
      code: 'documented_count_stale',
      subject: 'docs/START_HERE_TODAY.md',
      detail: 'documented 108 tools but the live server exposes 2',
    });
  });

  it('Given a mutator falsely marked read-only, When evaluated, Then mutation_marked_read_only is reported', () => {
    const inventory: ToolInventory = {
      tools: [{ ...mutation, annotations: { title: 'Apply', readOnlyHint: true, destructiveHint: false } }, reader],
    };

    const report = evaluateInventoryTruth(inventory, documented(2));

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual({
      code: 'mutation_marked_read_only',
      subject: 'sangfor_apply_approved_product_change',
      detail: 'mutation verb "apply" is annotated readOnlyHint:true',
    });
  });

  it('Given a destructive tool that is not in the write set, When evaluated, Then destructive_not_write is reported', () => {
    const inventory: ToolInventory = {
      tools: [
        { ...reader, name: 'sangfor_hci_delete_volume', annotations: { title: 'Delete', readOnlyHint: true, destructiveHint: true } },
      ],
    };

    const report = evaluateInventoryTruth(inventory, documented(1));

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual({
      code: 'destructive_not_write',
      subject: 'sangfor_hci_delete_volume',
      detail: 'destructiveHint:true contradicts readOnlyHint:true',
    });
  });

  it('Given a comparison-free run, When evaluated, Then the count is not compared and annotations still are', () => {
    const inventory: ToolInventory = {
      tools: [{ ...mutation, annotations: { title: 'Apply', readOnlyHint: true, destructiveHint: false } }],
    };

    const report = evaluateInventoryTruth(inventory, { kind: 'not_compared' });

    expect(report.violations.map((v) => v.code)).toEqual(['mutation_marked_read_only']);
  });

  it('Given a required comparison with no sources, When evaluated, Then documented_count_absent is reported', () => {
    const inventory: ToolInventory = { tools: [mutation, reader] };

    const report = evaluateInventoryTruth(inventory, { kind: 'required', counts: [] });

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual({
      code: 'documented_count_absent',
      subject: '<inputs>',
      detail: 'no documented tool-count input was supplied to compare against the live census',
    });
  });
});

describe('MCP inventory truth — untrusted artifact parsing', () => {
  it('Given a tools/list payload with a non-boolean hint, When parsed, Then it is rejected at the boundary', () => {
    const source = JSON.stringify({
      tools: [{ name: 'sangfor_x', description: 'x', annotations: { title: 't', readOnlyHint: 'yes', destructiveHint: false }, category: 'advisory' }],
    });

    expect(() => parseToolInventory(source)).toThrow(/RUNTIME_SCHEMA_INVALID/);
  });

  it('Given a duplicated tool name, When parsed and evaluated, Then duplicate_tool_name is reported', () => {
    const inventory: ToolInventory = { tools: [mutationTool(), mutationTool()] };

    const report = evaluateInventoryTruth(inventory, documented(2));

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual({
      code: 'duplicate_tool_name',
      subject: 'sangfor_apply_approved_product_change',
      detail: 'tool name appears 2 times in the live census',
    });
  });

  it('Given malformed JSON from the server, When parsed, Then a runtime schema error is thrown', () => {
    expect(() => parseToolInventory('not json')).toThrow(/RUNTIME_SCHEMA_INVALID/);
  });

  it('Given the committed false-read-only fixture, When evaluated, Then both hint defects are reported', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./fixtures/mcp-inventory/false-read-only-mutation.json', import.meta.url)),
      'utf8',
    );

    const report = evaluateInventoryTruth(parseToolInventory(source), { kind: 'not_compared' });

    expect(report.ok).toBe(false);
    expect([...new Set(report.violations.map((v) => v.code))].sort()).toEqual([
      'destructive_not_write',
      'mutation_marked_read_only',
    ]);
  });
});

function mutationTool() {
  return {
    name: 'sangfor_apply_approved_product_change',
    description: 'Apply an approved change',
    annotations: { title: 'Apply', readOnlyHint: false, destructiveHint: true },
    category: 'admin',
  } as const;
}
