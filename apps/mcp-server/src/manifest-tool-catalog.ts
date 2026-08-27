import { activeToolProfile, TOOL_PROFILES, PROFILE_DESCRIPTIONS } from './tool-profile.js';
import { listedTools as listTools, listedToolsForProfile as listToolsForProfile } from './tool-catalog-view.js';
import { PRODUCTS } from '../../../packages/shared/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const manifestToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_agent_manifest", {
    description: 'Agent self-onboarding manifest: recommended first calls, standard tool groups, tool exposure profile, and the read-only-by-default safety posture. Call this first to discover the server. Read-only; never mutates.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      server: 'sangfor-engineer-mcp',
      posture: 'read-only by default; device/external writes require explicit signed approval + SANGFOR_ALLOW_REAL_EXECUTION',
      recommended_first_calls: [
        'sangfor_products',
        'sangfor_capabilities',
        'sangfor_list_spec_coverage',
        'sangfor_search_manuals',
        'sangfor_analyze_project',
      ],
      standard_tools: [
        'sangfor_evaluate_config', 'sangfor_suggest_rca', 'sangfor_recommend_sizing', 'sangfor_check_version',
        'sangfor_analyze_project', 'sangfor_generate_config_plan', 'sangfor_generate_evidence_report',
        'sangfor_search_manuals', 'sangfor_search_wiki', 'sangfor_rag_search',
        'sangfor_advisor_fortios', 'sangfor_advisor_cisco_iosxe',
        'sangfor_hci_inventory', 'sangfor_hci_health_report',
        'sangfor_playbook_list', 'sangfor_pm_status',
      ],
      mutation_gating: 'Tools that change devices/external systems are gated: they require explicit user intent, a signed action-bound single-use approval, and SANGFOR_ALLOW_REAL_EXECUTION (production also SANGFOR_ALLOW_PRODUCTION_EXECUTION). Dry-run is the default.',
      activeProfile: activeToolProfile(),
      toolCountByProfile: Object.fromEntries(TOOL_PROFILES.map((p) => [p, listToolsForProfile(p).length])),
      profileDescriptions: PROFILE_DESCRIPTIONS,
      quickstart: {
        // Not published to a public registry (package.json is private:true) —
        // "npx sangfor-engineer-mcp" would not resolve. Real path: clone the
        // repo, `pnpm install` once, then run the bin script directly.
        stdio: 'node bin/sangfor-engineer-mcp.mjs (after: pnpm install, from a local clone)',
        setProfileExample: 'SANGFOR_TOOL_PROFILE=advisor node bin/sangfor-engineer-mcp.mjs',
      },
    })
  }],
  ["sangfor_capabilities", {
    description: 'Discovery: server capabilities — tool categories and counts, supported vendors/products, execution posture, and which write paths are gated. Read-only; never mutates.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const all = listTools();
      const byCategory: Record<string, number> = {};
      for (const t of all) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
      return {
        server: 'sangfor-engineer-mcp',
        toolCount: all.length,
        categories: byCategory,
        vendors: ['SANGFOR', 'FORTIOS', 'CISCO_IOSXE'],
        priorityProducts: PRODUCTS,
        executionPosture: {
          default: 'dry-run / read-only',
          liveWriteRequires: ['SANGFOR_ALLOW_REAL_EXECUTION', 'signed action-bound single-use approval'],
          productionAlsoRequires: ['SANGFOR_ALLOW_PRODUCTION_EXECUTION'],
          indeterminateIsNeverPass: true,
        },
        discoveryTools: ['sangfor_agent_manifest', 'sangfor_capabilities'],
      };
    }
  }],
];
