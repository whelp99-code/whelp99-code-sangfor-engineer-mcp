/**
 * MCP inventory truth — the live `tools/list` artifact is the only census.
 *
 * The expected tool count is never written down here: it is whatever the running
 * server answers. Documented counts are inputs to compare against that answer, so
 * a stale "108 tools" sentence in a doc fails the check instead of the server.
 * Annotation rules only ever detect a mutator that claims to be read-only — they
 * never rewrite a hint, because the http-bridge guard keys off those hints.
 */
import { z } from 'zod';
import { parseRuntimeJson, type RuntimeSchemaContract } from '../../packages/shared/src/runtime-schema.js';

const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  annotations: z.object({
    title: z.string().min(1),
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
  }),
  category: z.string().min(1),
});

const inventorySchema = z.object({ tools: z.array(toolSchema).readonly() });

export type ToolEntry = z.infer<typeof toolSchema>;
export type ToolInventory = z.infer<typeof inventorySchema>;

const INVENTORY_CONTRACT: RuntimeSchemaContract<ToolInventory> = {
  schema: inventorySchema,
  schemaName: 'McpToolInventory',
  policy: 'loud_failure',
};

export type DocumentedCount = {
  readonly source: string;
  readonly count: number;
};

/**
 * Documented counts are compared only when a caller supplies sources. CI runs the
 * annotation/write-set half on every push; the docs-regeneration gate passes its
 * doc sources and therefore also demands that at least one exists.
 */
export type DocumentedCountInput =
  | { readonly kind: 'required'; readonly counts: readonly DocumentedCount[] }
  | { readonly kind: 'not_compared' };

export type InventoryViolationCode =
  | 'documented_count_absent'
  | 'documented_count_stale'
  | 'mutation_marked_read_only'
  | 'destructive_not_write'
  | 'duplicate_tool_name';

export type InventoryViolation = {
  readonly code: InventoryViolationCode;
  readonly subject: string;
  readonly detail: string;
};

export type InventorySummary = {
  readonly total: number;
  readonly readOnlyTools: readonly string[];
  readonly writeTools: readonly string[];
  readonly destructiveTools: readonly string[];
};

export type InventoryReport = {
  readonly ok: boolean;
  readonly summary: InventorySummary;
  readonly violations: readonly InventoryViolation[];
};

/**
 * Verbs that change device, external-system or durable local state. A tool named
 * with one of these cannot honestly be read-only; the reverse is not asserted,
 * because this server deliberately marks non-verb local writers as writes too.
 */
const MUTATION_VERBS = ['apply', 'execute', 'delete', 'kill', 'promote', 'approve', 'upsert', 'ingest', 'import'] as const;

export function parseToolInventory(source: string): ToolInventory {
  return parseRuntimeJson(source, INVENTORY_CONTRACT);
}

export function summarizeInventory(inventory: ToolInventory): InventorySummary {
  const readOnlyTools: string[] = [];
  const writeTools: string[] = [];
  const destructiveTools: string[] = [];
  for (const tool of inventory.tools) {
    if (tool.annotations.readOnlyHint) readOnlyTools.push(tool.name);
    else writeTools.push(tool.name);
    if (tool.annotations.destructiveHint) destructiveTools.push(tool.name);
  }
  return { total: inventory.tools.length, readOnlyTools, writeTools, destructiveTools };
}

function mutationVerbOf(name: string): string | undefined {
  const bare = name.replace(/^sangfor_/, '');
  return MUTATION_VERBS.find((verb) => bare.startsWith(`${verb}_`) || bare.includes(`_${verb}_`));
}

function annotationViolations(inventory: ToolInventory): readonly InventoryViolation[] {
  const violations: InventoryViolation[] = [];
  for (const tool of inventory.tools) {
    const verb = mutationVerbOf(tool.name);
    if (verb !== undefined && tool.annotations.readOnlyHint) {
      violations.push({
        code: 'mutation_marked_read_only',
        subject: tool.name,
        detail: `mutation verb "${verb}" is annotated readOnlyHint:true`,
      });
    }
    if (tool.annotations.destructiveHint && tool.annotations.readOnlyHint) {
      violations.push({
        code: 'destructive_not_write',
        subject: tool.name,
        detail: 'destructiveHint:true contradicts readOnlyHint:true',
      });
    }
  }
  return violations;
}

function duplicateViolations(inventory: ToolInventory): readonly InventoryViolation[] {
  const counts = new Map<string, number>();
  for (const tool of inventory.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({
      code: 'duplicate_tool_name' as const,
      subject: name,
      detail: `tool name appears ${count} times in the live census`,
    }));
}

function countViolations(total: number, input: DocumentedCountInput): readonly InventoryViolation[] {
  if (input.kind === 'not_compared') return [];
  const documented = input.counts;
  if (documented.length === 0) {
    return [{
      code: 'documented_count_absent',
      subject: '<inputs>',
      detail: 'no documented tool-count input was supplied to compare against the live census',
    }];
  }
  return documented
    .filter(({ count }) => count !== total)
    .map(({ source, count }) => ({
      code: 'documented_count_stale' as const,
      subject: source,
      detail: `documented ${count} tools but the live server exposes ${total}`,
    }));
}

export function evaluateInventoryTruth(
  inventory: ToolInventory,
  documented: DocumentedCountInput,
): InventoryReport {
  const summary = summarizeInventory(inventory);
  const violations = [
    ...countViolations(summary.total, documented),
    ...annotationViolations(inventory),
    ...duplicateViolations(inventory),
  ];
  return { ok: violations.length === 0, summary, violations };
}
