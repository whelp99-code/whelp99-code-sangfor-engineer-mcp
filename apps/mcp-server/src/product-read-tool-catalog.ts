import { discoverProductConsole, collectProductConfig, analyzeCustomerRequirements, generateProductChangePlan, importExcelRequirementList, mapRequirementsToProducts, generateExcelBasedChangePlan } from '../../../packages/sangfor-product-adapters/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const productReadToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_discover_product_console", {
    description: 'Discover product console strategy, login/API likelihood, menu routes and product capabilities for HCI/SCP, IAG, Endpoint Secure or NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: discoverProductConsole
  }],
  ["sangfor_collect_product_config", {
    description: 'Collect or plan read-only collection of current product configuration. Uses API-first for HCI/SCP, WebUI-first for IAG/Endpoint Secure, hybrid for NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: collectProductConfig
  }],
  ["sangfor_analyze_customer_requirements", {
    description: 'Break customer requirement strings into product-specific configuration tasks with menu paths, API candidates, risk and approval gates.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: analyzeCustomerRequirements
  }],
  ["sangfor_generate_product_change_plan", {
    description: 'Generate product change plan with menu path, API endpoint candidates, current/target planning context, impact/risk, rollback and validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: generateProductChangePlan
  }],
  ["sangfor_import_excel_requirement_list", {
    description: 'Import an ITAC-style Excel checklist and normalize rows into configuration requirements, evidence needs, target controls, gaps and priority.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } }, required: ['filePath'] },
    handler: importExcelRequirementList
  }],
  ["sangfor_map_requirements_to_products", {
    description: 'Map normalized Excel checklist rows to HCI/SCP, IAG, Endpoint Secure, NDR, or external/manual handling.',
    inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } }, required: ['rows'] },
    handler: mapRequirementsToProducts
  }],
  ["sangfor_generate_excel_based_change_plan", {
    description: 'Generate a multi-product dry-run change plan from an ITAC-style Excel checklist. Actual mutation remains blocked.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } } },
    handler: generateExcelBasedChangePlan
  }],
];
