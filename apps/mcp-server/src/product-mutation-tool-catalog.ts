import { dryRunProductChange, applyApprovedProductChange, verifyProductChange } from '../../../packages/sangfor-product-adapters/src/index.js';
import { iagOrchestratorToolCatalog } from './iag-orchestrator-tools.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';
import { requiredBrowserExecutionPort } from './browser-runtime-composition.js';

export const productMutationToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_dry_run_product_change", {
    description: 'Dry-run a product change plan. WebUI route preview stops before Save/Apply/Delete; API changes produce request previews only.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, targetUrl: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: (args: Parameters<typeof dryRunProductChange>[0] & { sessionId?: string }) => dryRunProductChange({
      ...args,
      ...(args.sessionId
        ? { browserExecutionPort: requiredBrowserExecutionPort() }
        : {}),
    })
  }],
  ["sangfor_apply_approved_product_change", {
    description: 'Deprecated write surface: typed-refuses every real apply. Use a verified product-specific orchestrator; dry-run planning remains available separately.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, approval: { type: 'object' }, environment: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: applyApprovedProductChange
  }],
  ["sangfor_verify_product_change", {
    description: 'Verify a product change with read-only API/WebUI re-collection checklist and evidence expectations.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, observed: { type: 'object' } }, required: ['plan'] },
    handler: verifyProductChange
  }],
  ...Object.entries(iagOrchestratorToolCatalog(requiredBrowserExecutionPort)),
];
