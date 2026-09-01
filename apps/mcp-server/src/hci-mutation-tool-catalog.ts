import { auditRoot, mcpLocalAuthority } from './authority-path-support.js';
import { hciAuthorityReferences, hciClientFor } from './hci-tool-support.js';
import { assertLocalAuditAuthorityAllowed, applyCreateVolume, AuditLedger, getVolume, deleteVolume } from '../../../packages/sangfor-hci-client/src/index.js';
import { authorizeHciMutation } from '../../../packages/sangfor-operator/src/index.js';
import { nowId } from '../../../packages/shared/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const hciMutationToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_hci_apply_create_volume", {
    description: 'WRITE: apply a planned create-volume through the state machine (idempotent POST -> read-back verify -> succeed or HALT). Requires explicit signed approval (action-bound, single-use nonce). On a non-loopback (real device) target it is additionally gated by SANGFOR_ALLOW_REAL_EXECUTION and an auto_allowed safety class (volume_create stays human_only until the M4 real-device promotion). Over the HTTP bridge it additionally needs a bridge-level bridge.tool-call approval.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, clientToken: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb', 'clientToken', 'approval'] },
    handler: async (args: { name: string; sizeGb: number; description?: string; clientToken: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as Record<string, unknown>);
      assertLocalAuditAuthorityAllowed();
      const authorization = await authorizeHciMutation({
        action: {
          kind: 'hci.create-volume', target: `${cfg.host}:${args.name}`,
          identityBaseUrl: cfg.identityBaseUrl, capabilityId: 'volume_create',
        },
        approval: args.approval,
        authority: hciAuthorityReferences(),
      });
      if (authorization.kind === 'REFUSED') return { ok: false, mutationPerformed: false, error: authorization.code };
      const result = await applyCreateVolume(client, { name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken: args.clientToken }, new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) }));
      return {
        ...result, mutationPerformed: result.finalState === 'SUCCEEDED' || Boolean(result.volumeId),
        ledger: new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) }).pathFor(result.runId),
      };
    }
  }],
  ["sangfor_hci_delete_volume", {
    description: 'DESTRUCTIVE: delete a volume (the reverse op of create). Requires a SignedApproval bound to the exact volumeId. Over the HTTP bridge it additionally needs a bridge-level bridge.tool-call approval, and on a non-loopback (real) device it is refused until volume_delete is promoted out of human_only. Gated by SANGFOR_ALLOW_REAL_EXECUTION and requires explicit signed approval bound to the exact volumeId.',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['volumeId', 'approval'] },
    handler: async (args: { volumeId: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as Record<string, unknown>);
      assertLocalAuditAuthorityAllowed();
      const authorization = await authorizeHciMutation({
        action: {
          kind: 'hci.delete-volume', target: `${cfg.host}:${args.volumeId}`,
          identityBaseUrl: cfg.identityBaseUrl, capabilityId: 'volume_delete',
        },
        approval: args.approval,
        authority: hciAuthorityReferences(),
      });
      if (authorization.kind === 'REFUSED') return { ok: false, mutationPerformed: false, error: authorization.code };
      const before = await getVolume(client, args.volumeId);
      if (!before) return { ok: false, mutationPerformed: false, error: `volume ${args.volumeId} not found` };
      const res = await deleteVolume(client, args.volumeId);
      const ledger = new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) });
      const runId = nowId('hci_delete');
      await ledger.append(runId, 'request', { op: 'delete-volume', volumeId: args.volumeId, before });
      await ledger.append(runId, 'response', { status: res.status });
      return { ok: res.status === 202, mutationPerformed: res.status === 202, status: res.status, runId };
    }
  }],
];
