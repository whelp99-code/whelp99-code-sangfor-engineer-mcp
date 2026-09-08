import type { ToolProfile } from './mcp-contracts.js';
import { listedTools } from './tool-catalog-view.js';
import { activeToolProfile, isToolVisibleInProfile } from './tool-profile.js';

export type PromptDef = {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  render: (args: Record<string, string>) => string;
};

const PROMPTS: PromptDef[] = [
  {
    name: 'sangfor-health-check',
    description: 'Advisory health-check workflow for a Sangfor/FortiOS/Cisco device: discover the server, run the right advisor tool, evaluate against spec, then collect evidence.',
    arguments: [
      { name: 'product', description: 'Target product/vendor, e.g. SANGFOR HCI_SCP, FORTIOS, CISCO_IOSXE', required: false },
    ],
    render: (args) => [
      `Run a read-only health check${args.product ? ` for ${args.product}` : ''}. Follow this order:`,
      '1. Call sangfor_agent_manifest (or sangfor_capabilities) to confirm which tools are available in the current profile.',
      '2. Call the matching advisor tool: sangfor_advisor_fortios / sangfor_advisor_fortios_advanced for FortiOS, sangfor_advisor_cisco_iosxe / sangfor_advisor_cisco_iosxe_advanced for Cisco IOS-XE, or sangfor_hci_inventory / sangfor_hci_health_report for Sangfor HCI/SCP.',
      '3. If you have an observed config instead of live device access, call sangfor_evaluate_config against the IntendedSpec (use sangfor_list_spec_coverage to see what specs exist).',
      '4. Summarize findings and call sangfor_generate_evidence_report to produce a citable evidence record. Never claim a device was changed — every tool above is read-only.',
    ].join('\n'),
  },
  {
    name: 'sangfor-config-plan',
    description: 'Turn customer requirements into a config plan with risk classification and a validation plan, without touching a device.',
    arguments: [
      { name: 'requirements', description: 'Free-text customer requirements to plan for', required: false },
    ],
    render: (args) => [
      `Build a configuration plan${args.requirements ? ` for: ${args.requirements}` : ''}. Follow this order:`,
      '1. Call sangfor_analyze_customer_requirements (or sangfor_analyze_project) to break requirements into product-specific tasks.',
      '2. Call sangfor_generate_config_plan to produce the precheck/steps/rollback/validation plan.',
      '3. Call sangfor_request_approval to classify the risk of the plan text before proposing any execution.',
      '4. Call sangfor_validate_config_plan to confirm the plan has precheck, steps, rollback and validation before handing it to a human for approval. Do not call any apply_*/execute_* tool from this workflow — those require separate explicit human approval.',
    ].join('\n'),
  },
  {
    name: 'sangfor-troubleshoot',
    description: 'Evidence-first troubleshooting workflow: gather grounded evidence before proposing root causes.',
    arguments: [
      { name: 'symptom', description: 'Observed symptom to investigate', required: false },
    ],
    render: (args) => [
      `Troubleshoot${args.symptom ? `: ${args.symptom}` : ' the reported symptom'}. Follow this order:`,
      '1. Call sangfor_rag_search to collect grounded evidence (manuals, KB, prior lessons) relevant to the symptom. Do not skip this — root causes must be grounded, not guessed.',
      '2. From the retrieved evidence, form one or more hypotheses about the likely cause.',
      '3. Call sangfor_suggest_rca with the symptom (and product, if known) to get ranked root-cause candidates and concrete check steps, and compare them against your hypotheses.',
      '4. If you reach an evaluable observed config, call sangfor_evaluate_config to confirm/refute a hypothesis, then sangfor_generate_evidence_report to record findings.',
    ].join('\n'),
  },
];

const PROMPT_TOOL_NAME_PATTERN = /sangfor_[a-z0-9_]+/g;

// Single source of truth for "which tools does this prompt tell the caller to
// use": scan the rendered body for sangfor_* references. Args only interpolate
// free text (product/requirements/symptom) — they never change which tool
// names appear in the fixed step list, so an empty-args render is exact and
// stable, and both the profile gate below and tests/mcp-prompts.test.ts read
// from this one function instead of duplicating the regex.
export function referencedToolNames(prompt: PromptDef): string[] {
  const text = prompt.render({});
  return Array.from(new Set(text.match(PROMPT_TOOL_NAME_PATTERN) ?? []));
}

// A prompt is only as available as every tool it walks the caller through.
// If ANY referenced tool is hidden in the active profile, the whole prompt is
// hidden too — a partially-runnable workflow is worse than an absent one.
// Fail-closed on an unresolvable reference (should never happen; covered by
// the tool-existence test) rather than assuming it's fine.
function isPromptVisibleInProfile(prompt: PromptDef, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  const toolsByName = new Map(listedTools().map((t) => [t.name, t]));
  return referencedToolNames(prompt).every((toolName) => {
    const tool = toolsByName.get(toolName);
    return tool ? isToolVisibleInProfile(tool, profile) : false;
  });
}

export function listPrompts(profile: ToolProfile = activeToolProfile()) {
  return PROMPTS.filter((p) => isPromptVisibleInProfile(p, profile)).map(({ name, description, arguments: args }) => ({
    name,
    description,
    ...(args ? { arguments: args } : {}),
  }));
}

export function getPrompt(name: string, args?: Record<string, unknown>, profile: ToolProfile = activeToolProfile()) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  if (!isPromptVisibleInProfile(prompt, profile)) {
    throw new Error(`Prompt requires tools hidden in profile '${profile}'`);
  }
  const stringArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) if (typeof v === 'string') stringArgs[k] = v;
  return { messages: [{ role: 'user', content: { type: 'text', text: prompt.render(stringArgs) } }] };
}
