export type { AdapterProductCode, ProductRegistryEntry, ProductRegistryView, SpecProductMapping } from '@sangfor/learning-strategy';

export {
  buildComprehensiveOperationsGuideDocx,
  buildComprehensiveSettingGuideDocx,
  buildOperationsGuideDocx,
  buildSettingGuideDocx,
} from './docx-builder.js';
export type { DocxBuilderInput, DocxBuilderResult } from './docx-builder.js';
export * from './apply/index.js';
export * from './types.js';
export {
  getProductRegistrySnapshot,
  resolveProductAdapterStrict,
} from './registry-identity.js';
export {
  collectProductConfig,
  discoverProductConsole,
  getProductAdapter,
  listProductAdapters,
  normalizeAutomationProduct,
} from './source-mapping.js';
export {
  analyzeCustomerRequirements,
  generateProductChangePlan,
  ingestTextRequirementsForCase,
} from './requirement-planning.js';
export { importExcelRequirementList } from './excel-import.js';
export {
  generateExcelBasedChangePlan,
  ingestEngineerRequirements,
  ingestExcelRequirementsForCase,
  mapRequirementsToProducts,
} from './excel-planning.js';
export {
  ENGINEER_REQUIREMENT_MAX_XLSX_BYTES,
  assertEngineerRequirementFile,
} from './engineer-requirement-guard.js';
export type {
  EngineerRequirementIngestResult,
  EngineerRequirementQuestion,
  EngineerRequirementTracking,
} from './engineer-requirement-ingest.js';
export {
  applyApprovedProductChange,
  dryRunProductChange,
  verifyProductChange,
} from './apply-verify.js';
export * from './observer-spec-adapter.js';
