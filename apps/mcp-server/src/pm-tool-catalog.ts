import { pmStore } from './domain-session-state.js';
import { paginateOptionalField } from './catalog-query-support.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const pmToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_pm_create_engagement", {
    description: 'PM: create an engagement (customer project). Local PM-ledger write; requires explicit user intent (customer and product), recorded as a hash-chained audit event.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string' }, product: { type: 'string' } }, required: ['customer', 'product'] },
    handler: (args: { customer: string; product: string }) => pmStore.createEngagement(args)
  }],
  ["sangfor_pm_add_work_item", {
    description: 'PM: add a work item to an engagement. Local PM-ledger write; requires explicit engagementId, recorded as a hash-chained audit event.',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' }, title: { type: 'string' }, deviceId: { type: 'string' }, assignee: { type: 'string' } }, required: ['engagementId', 'title'] },
    handler: (args: { engagementId: string; title: string; deviceId?: string; assignee?: string }) => pmStore.addWorkItem(args.engagementId, args)
  }],
  ["sangfor_pm_status", {
    description: 'PM: status rollup for an engagement + current device occupancy (who holds which device).',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' } }, required: ['engagementId'] },
    handler: (args: { engagementId: string }) => ({ rollup: pmStore.statusRollup(args.engagementId), deviceOccupancy: pmStore.deviceOccupancy(), chainOk: pmStore.verifyEventChain(args.engagementId) })
  }],
  ["sangfor_pm_events", {
    description: 'PM (read-only): the tamper-evident event timeline for an engagement + chain integrity status. Unknown engagement errors (no fake empty timeline). Optional cursor/limit page the event timeline; omit both for the full timeline (default, backward-compatible).',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['engagementId'] },
    handler: (args: { engagementId: string; cursor?: string; limit?: number }) => {
      if (!pmStore.getEngagement(args.engagementId)) throw new Error(`Engagement not found: ${args.engagementId}`);
      // chainOk verifies the FULL chain regardless of pagination — only the
      // returned `events` listing is windowed.
      return {
        ...paginateOptionalField(pmStore.getEvents(args.engagementId), args, (e) => e.id, 'events'),
        chainOk: pmStore.verifyEventChain(args.engagementId),
      };
    }
  }],
  ["sangfor_pm_report", {
    description: 'PM (read-only): a citable Korean progress report derived ONLY from recorded events (rollup %, work items, event timeline, audit-chain-broken banner if tampered). No unrecorded-progress guessing.',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' } }, required: ['engagementId'] },
    handler: (args: { engagementId: string }) => ({ report: pmStore.renderStatusReport(args.engagementId) })
  }],
  ["sangfor_pm_acquire_device", {
    description: 'PM safety: acquire an exclusive device lock for an engagement before any device work. Blocks if another engagement holds it (prevents cross-engagement changes on a shared lab device).',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, engagementId: { type: 'string' }, holder: { type: 'string' } }, required: ['deviceId', 'engagementId', 'holder'] },
    handler: (args: { deviceId: string; engagementId: string; holder: string }) => pmStore.acquireDevice(args.deviceId, args.engagementId, args.holder)
  }],
  ["sangfor_pm_release_device", {
    description: 'PM safety: release a device lock held by an engagement (records a device_released audit event). Returns false if the engagement does not hold the lock.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, engagementId: { type: 'string' } }, required: ['deviceId', 'engagementId'] },
    handler: (args: { deviceId: string; engagementId: string }) => ({ released: pmStore.releaseDevice(args.deviceId, args.engagementId) })
  }],
];
