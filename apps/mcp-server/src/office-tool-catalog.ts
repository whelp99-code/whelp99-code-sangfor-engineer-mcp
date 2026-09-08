import { buildSettingGuideDocx, buildOperationsGuideDocx, buildComprehensiveSettingGuideDocx, buildComprehensiveOperationsGuideDocx } from '../../../packages/sangfor-product-adapters/src/index.js';
import { buildSettingGuidePptx, buildOperationsGuidePptx } from '../../../packages/sangfor-pptx/src/index.js';
import { isOfficeCliAvailable, validateOfficeDocument } from '../../../packages/sangfor-office/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const officeToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_generate_setting_guide_docx", {
    description: 'Generate a Word (.docx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted document with product tables, manual evidence section, dry-run procedure, and customer action items.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string }) => buildSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath })
  }],
  ["sangfor_generate_setting_guide_pptx", {
    description: 'Generate a PowerPoint (.pptx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted presentation with product-specific slides, tables, charts, and dry-run procedures.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .pptx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildSettingGuidePptx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  }],
  ["sangfor_generate_operations_guide_pptx", {
    description: 'Generate a PowerPoint (.pptx) operations guide for Sangfor products covering daily monitoring, weekly/monthly procedures, incident response, and security policies.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .pptx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuidePptx({ outputPath: args.outputPath })
  }],
  ["sangfor_generate_operations_guide_docx", {
    description: 'Generate a Word (.docx) operations guide for Sangfor products covering daily monitoring, weekly/monthly inspection, incident response, and security policy management.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuideDocx({ outputPath: args.outputPath })
  }],
  ["sangfor_generate_comprehensive_setting_guide_docx", {
    description: 'Generate a comprehensive Word (.docx) customer setting guide with detailed setup procedures, product-specific configuration, operational steps, security policies, backup/recovery, and troubleshooting. Much more detailed than the basic setting guide.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  }],
  ["sangfor_generate_comprehensive_operations_guide_docx", {
    description: 'Generate a comprehensive Word (.docx) operations guide covering detailed daily/weekly/monthly procedures, incident response, backup/recovery, security policy management, performance monitoring, and troubleshooting FAQ.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } } },
    handler: (args: { outputPath?: string; screenshotDir?: string }) => buildComprehensiveOperationsGuideDocx({ outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  }],
  ["sangfor_validate_office_document", {
    description: 'Read-only: validate a .docx/.xlsx/.pptx against the OpenXML schema via officecli, for a pre-submission sanity check before handing a generated document to a customer. Returns {valid, errorCount, errors, note?} plus officecli availability — valid:null (not false) when officecli is not installed on this host, so a missing officecli is never mistaken for a broken document.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the .docx/.xlsx/.pptx file to validate.' },
      },
      required: ['filePath'],
    },
    handler: async (args: { filePath: string }) => {
      const availability = isOfficeCliAvailable();
      const validation = await validateOfficeDocument(args.filePath);
      return { ...validation, officeCli: availability };
    },
  }],
];
