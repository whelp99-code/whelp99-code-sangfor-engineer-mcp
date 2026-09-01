import { PRODUCTS } from '../../../packages/shared/src/index.js';
import { HCI_AUTH_CONTRACT_STATUS, collectInventory, summarizeHciHealth, renderHciHealthReport, validateCreateVolumeInput, readBackVolume } from '../../../packages/sangfor-hci-client/src/index.js';
import { hciClientFor } from './hci-tool-support.js';
import { randomBytes } from 'node:crypto';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const hciReadToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_products", {
    description: 'List supported Sangfor products in current priority order.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ products: PRODUCTS })
  }],
  ["sangfor_hci_inventory", {
    description: `Read-only HCI/SCP inventory over the OpenAPI surface (volumes/servers/images). Auth contract: ${HCI_AUTH_CONTRACT_STATUS}.`,
    inputSchema: { type: 'object', properties: { identityBaseUrl: { type: 'string' }, tenantName: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } },
    handler: async (args: Record<string, unknown>) => {
      const { client } = hciClientFor(args);
      return { ...(await collectInventory(client)), authContract: HCI_AUTH_CONTRACT_STATUS };
    }
  }],
  ["sangfor_hci_health_report", {
    description: `Read-only HCI/SCP operations health report (volume status distribution, error volumes, findings) rendered as a Korean advisory. Never mutates. Auth contract: ${HCI_AUTH_CONTRACT_STATUS}.`,
    inputSchema: { type: 'object', properties: { identityBaseUrl: { type: 'string' }, tenantName: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } },
    handler: async (args: Record<string, unknown>) => {
      const { client, cfg } = hciClientFor(args);
      const inv = await collectInventory(client);
      const summary = summarizeHciHealth(inv);
      return { summary, report: renderHciHealthReport(summary, { host: cfg.host, collectedAt: new Date().toISOString() }), authContract: HCI_AUTH_CONTRACT_STATUS };
    }
  }],
  ["sangfor_hci_plan_create_volume", {
    description: 'Plan (no mutation): validate a create-volume intent, mint the idempotency clientToken, and describe the SignedApproval required to apply. No device mutation here; applying requires explicit user intent via the separate hci_apply_create_volume (signed, single-use approval).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: (args: { name: string; sizeGb: number; description?: string; identityBaseUrl?: string }) => {
      const clientToken = `cv-${randomBytes(8).toString('hex')}`;
      const problems = validateCreateVolumeInput({ name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken });
      const { cfg } = hciClientFor(args as Record<string, unknown>);
      return {
        ok: problems.length === 0, problems, mutationPerformed: false,
        plannedRequest: { method: 'POST', path: '/volumes', body: { volume: { name: args.name, size: args.sizeGb, description: args.description ?? null } }, idempotencyHeader: { 'X-Client-Token': clientToken } },
        clientToken,
        approvalRequired: { action: { type: 'hci.create-volume', target: `${cfg.host}:${args.name}` }, fields: ['approvedBy', 'approvalToken', 'changeTicketId', 'rollbackPlanId', 'nonce', 'expiresAt'], mint: 'scripts/mint-hci-approval.ts' },
        rollback: { op: 'hci.delete-volume', note: 'the single documented reverse op; requires its own approval' },
        authContract: HCI_AUTH_CONTRACT_STATUS,
      };
    }
  }],
  ["sangfor_hci_verify_volume", {
    description: 'Read-only read-back verification of a volume against an expectation (PASS/FAIL/INDETERMINATE; INDETERMINATE never passes).',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, name: { type: 'string' }, sizeGb: { type: 'number' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: async (args: { volumeId?: string; name: string; sizeGb: number; identityBaseUrl?: string }) => {
      const { client } = hciClientFor(args as Record<string, unknown>);
      return readBackVolume(client, { volumeId: args.volumeId, name: args.name, sizeGb: args.sizeGb });
    }
  }],
];
