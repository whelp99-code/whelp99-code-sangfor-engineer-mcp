import { TOOL_PROFILES, type AdvertisedTool, type ToolCatalogEntry, type ToolProfile } from './mcp-contracts.js';

const DESTRUCTIVE_TOOLS = new Set([
  'sangfor_apply_approved_product_change',
  'sangfor_execute_console_action',
  'sangfor_execute_console_action_live',
  'sangfor_apply_wiki_update',
  'sangfor_apply_github_wiki_update',
  'sangfor_apply_obsidian_wiki_update',
  'sangfor_hci_delete_volume',
  'sangfor_iag_exception_apply',
]);

const WRITE_TOOLS = new Set([
  'sangfor_pm_create_engagement', 'sangfor_pm_add_work_item', 'sangfor_pm_acquire_device', 'sangfor_pm_release_device',
  'sangfor_create_eval_case_from_feedback', 'sangfor_create_finetune_dataset', 'sangfor_create_finetune_job_spec',
  'sangfor_propose_wiki_update', 'sangfor_approve_wiki_update', 'sangfor_upsert_knowledge_card',
  'sangfor_ingest_document', 'sangfor_learn_sources', 'sangfor_import_excel_requirement_list',
  'sangfor_submit_feedback', 'sangfor_extract_lesson', 'sangfor_request_approval', 'sangfor_run_planner_eval',
  'sangfor_capture_screenshots', 'sangfor_console_capture_evidence', 'sangfor_start_operator_session', 'sangfor_kill_session',
  'sangfor_generate_all_guides', 'sangfor_generate_comprehensive_operations_guide_docx',
  'sangfor_generate_comprehensive_setting_guide_docx', 'sangfor_generate_config_plan',
  'sangfor_generate_evidence_report', 'sangfor_generate_excel_based_change_plan', 'sangfor_session_report',
  'sangfor_generate_operations_guide_docx', 'sangfor_generate_operations_guide_pptx',
  'sangfor_generate_product_change_plan', 'sangfor_generate_setting_guide_docx', 'sangfor_generate_setting_guide_pptx',
  'sangfor_build_evidence_package',
  'sangfor_hci_apply_create_volume',
  'sangfor_attach_observation_session', 'sangfor_manage_learning_capture', 'sangfor_collect_facts',
  'sangfor_research_learning_strategy', 'sangfor_validate_learning_strategy', 'sangfor_promote_learning_strategy',
  'sangfor_playbook_create', 'sangfor_playbook_add_revision', 'sangfor_playbook_execute',
  'sangfor_playbook_submit_analysis', 'sangfor_playbook_close_agent_task',
]);

function categoryOf(name: string): string {
  const n = name.replace(/^sangfor_/, '');
  if (DESTRUCTIVE_TOOLS.has(name)) return 'admin';
  if (n.startsWith('playbook_')) return 'playbook';
  if (n.startsWith('hci_')) return 'hci';
  if (n.startsWith('pm_')) return 'pm';
  if (/wiki/.test(n)) return 'wiki';
  if (n.startsWith('generate_') || /report|guide|excel|evidence_package/.test(n)) return 'report';
  if (/rag|search|manual|store_health|discover/.test(n)) return 'knowledge';
  if (/finetune|eval|feedback|lesson/.test(n)) return 'ml';
  if (/console|operator|session|screenshot|collect/.test(n)) return 'collect';
  return 'advisory';
}

export function annotationsFor(name: string, description: string) {
  const destructive = DESTRUCTIVE_TOOLS.has(name);
  const write = destructive || WRITE_TOOLS.has(name);
  return {
    title: (description.split(/[.:—]/)[0] || name).slice(0, 60).trim(),
    readOnlyHint: !write,
    destructiveHint: destructive,
  };
}

export function advertiseTools(entries: readonly ToolCatalogEntry[]): AdvertisedTool[] {
  return entries.map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: annotationsFor(name, tool.description),
    category: categoryOf(name),
  }));
}

export { TOOL_PROFILES };
export type { ToolProfile };

export function activeToolProfile(): ToolProfile {
  const raw = process.env.SANGFOR_TOOL_PROFILE;
  if (raw === undefined || raw === '') return 'full';
  if ((TOOL_PROFILES as readonly string[]).includes(raw)) return raw as ToolProfile;
  process.stderr.write(`[mcp] unrecognized SANGFOR_TOOL_PROFILE '${raw}' — falling back to most-restrictive 'advisor'\n`);
  return 'advisor';
}

export function isToolVisibleInProfile(tool: { annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint !== false;
  if (profile === 'advisor') return readOnly;
  return readOnly || !destructive;
}

export function toolsForProfile(entries: readonly ToolCatalogEntry[], profile: ToolProfile = activeToolProfile()): AdvertisedTool[] {
  const all = advertiseTools(entries);
  return profile === 'full' ? all : all.filter((tool) => isToolVisibleInProfile(tool, profile));
}

export const PROFILE_DESCRIPTIONS: Record<ToolProfile, string> = {
  advisor: 'Read-only advisory tools only (search, evaluate, sizing, RCA, coverage) — never writes or mutates anything.',
  operator: 'Advisor tools plus approval-gated local/plan writes (PM ledger, plans, drafts, playbook authoring) — excludes destructive device/external mutators.',
  full: 'Every tool, including destructive device/external mutators gated by signed approval + SANGFOR_ALLOW_REAL_EXECUTION.',
};
