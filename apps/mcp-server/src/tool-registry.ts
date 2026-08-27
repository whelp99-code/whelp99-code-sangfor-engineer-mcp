import { advisoryToolCatalog } from './advisory-tool-catalog.js';
import { auditToolCatalog } from './audit-tool-catalog.js';
import { captureToolCatalog } from './capture-tool-catalog.js';
import { feedbackToolCatalog } from './feedback-tool-catalog.js';
import { hciMutationToolCatalog } from './hci-mutation-tool-catalog.js';
import { hciReadToolCatalog } from './hci-read-tool-catalog.js';
import { inventoryAnalysisToolCatalog } from './inventory-analysis-tool-catalog.js';
import { knowledgeToolCatalog } from './knowledge-tool-catalog.js';
import { learningToolCatalog } from './learning-tool-catalog.js';
import { manifestToolCatalog } from './manifest-tool-catalog.js';
import type { ToolCatalogEntry, ToolHandler, ToolProfile } from './mcp-contracts.js';
import { observabilityToolCatalog } from './observability-tool-catalog.js';
import { officeToolCatalog } from './office-tool-catalog.js';
import { operatorSessionToolCatalog } from './operator-session-tool-catalog.js';
import { plannerToolCatalog } from './planner-tool-catalog.js';
import { playbookToolCatalog } from './playbook-tool-catalog.js';
import { pmToolCatalog } from './pm-tool-catalog.js';
import { productMutationToolCatalog } from './product-mutation-tool-catalog.js';
import { productReadToolCatalog } from './product-read-tool-catalog.js';
import { specToolCatalog } from './spec-tool-catalog.js';
import { configureToolCatalogView } from './tool-catalog-view.js';
import { advertiseTools, toolsForProfile } from './tool-profile.js';
import { TOOL_REGISTRATION_ORDER } from './tool-registration-order.js';
import { createToolRuntime } from './tool-validation.js';
import { vendorReadToolCatalog } from './vendor-read-tool-catalog.js';

const catalogGroups: readonly (readonly ToolCatalogEntry[])[] = [
  hciReadToolCatalog,
  hciMutationToolCatalog,
  productReadToolCatalog,
  officeToolCatalog,
  captureToolCatalog,
  productMutationToolCatalog,
  knowledgeToolCatalog,
  plannerToolCatalog,
  operatorSessionToolCatalog,
  feedbackToolCatalog,
  specToolCatalog,
  vendorReadToolCatalog,
  inventoryAnalysisToolCatalog,
  advisoryToolCatalog,
  pmToolCatalog,
  learningToolCatalog,
  playbookToolCatalog,
  manifestToolCatalog,
  observabilityToolCatalog,
  auditToolCatalog,
];

const unorderedEntries = catalogGroups.flat();
const definitions = new Map(unorderedEntries);
if (definitions.size !== unorderedEntries.length) throw new Error('DUPLICATE_MCP_TOOL_NAME');
const catalogEntries = TOOL_REGISTRATION_ORDER.map((name) => {
  const definition = definitions.get(name);
  if (definition === undefined) throw new Error(`MISSING_MCP_TOOL_REGISTRATION: ${name}`);
  return [name, definition] as const;
});
if (catalogEntries.length !== definitions.size) throw new Error('UNEXPECTED_MCP_TOOL_REGISTRATION');

export const toolRuntime = createToolRuntime(catalogEntries);

export function getToolHandler(name: string): ToolHandler | undefined {
  return toolRuntime.definition(name)?.handler;
}

export function listTools() {
  return advertiseTools(catalogEntries);
}

export function listToolsForProfile(profile?: ToolProfile) {
  return toolsForProfile(catalogEntries, profile);
}

export function toolValidatorCount(): number {
  return toolRuntime.validatorCount;
}

configureToolCatalogView({ listTools, listToolsForProfile });
