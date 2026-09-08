import { suggestRca } from '../../../packages/sangfor-rca/src/index.js';
import { recommendSizing } from '../../../packages/sangfor-sizing/src/index.js';
import type { SizingInput } from '../../../packages/sangfor-sizing/src/index.js';
import { listIntegrationTypes, generateIntegrationGuide } from '../../../packages/sangfor-integration/src/index.js';
import { loadVersionRequirements, checkVersionRequirement } from '../../../packages/sangfor-version/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const advisoryToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_suggest_rca", {
    description: 'Suggest ranked root-cause candidates + concrete check steps for a symptom (read-only advisory). Grounded in product manuals; returns empty (no fabrication) for unrelated symptoms.',
    inputSchema: { type: 'object', properties: { symptom: { type: 'string' }, product: { type: 'string' } }, required: ['symptom'] },
    handler: (args: { symptom: string; product?: string }) => suggestRca(args.symptom, args.product)
  }],
  ["sangfor_recommend_sizing", {
    description: 'Advisory sizing tier (small/medium/large/xlarge) from the primary scale driver (IAG=users, EPP=endpoints, HCI=vmCount, CC=eps, NGFW=Mbps). Never invents an exact model/BOM — defers to official Sizing Guide + SE validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, concurrentUsers: { type: 'number' }, endpoints: { type: 'number' }, vmCount: { type: 'number' }, eventsPerSecond: { type: 'number' }, throughputMbps: { type: 'number' } }, required: ['product'] },
    handler: (args: { product: string } & SizingInput) => recommendSizing(args.product, args)
  }],
  ["sangfor_integration_guide", {
    description: 'Standard integration guide (AD/LDAP, RADIUS, SIEM/syslog): cited prerequisites → steps → validation → pitfalls for the human to follow. Unknown integration type returns an error (no fabrication). No type → list supported types.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'LDAP/AD, RADIUS, or SIEM/syslog' }, product: { type: 'string' } } },
    handler: (args: { type?: string; product?: string }) => {
      if (!args.type) return { supported: listIntegrationTypes() };
      const g = generateIntegrationGuide(args.type, args.product);
      return g ?? { error: `Unknown integration type "${args.type}". Supported: ${listIntegrationTypes().join(', ')}` };
    }
  }],
  ["sangfor_check_version", {
    description: 'Upgrade advisory: check a device version against the collected Version Requirements (min/recommended) and return meetsMin/atRecommended + cited advice. Returns null-style error for unknown devices (no fabricated compatibility claim). No args → list known requirements.',
    inputSchema: { type: 'object', properties: { device: { type: 'string' }, currentVersion: { type: 'string' } } },
    handler: (args: { device?: string; currentVersion?: string }) => {
      if (!args.device || !args.currentVersion) return { requirements: loadVersionRequirements() };
      const r = checkVersionRequirement(args.device, args.currentVersion);
      return r ?? { error: `No version requirement on file for device "${args.device}". Known: ${loadVersionRequirements().map((x) => x.device).join(', ')}` };
    }
  }],
];
