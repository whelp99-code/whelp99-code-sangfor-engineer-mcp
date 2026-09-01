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
} from './requirement-planning.js';
export { importExcelRequirementList } from './excel-import.js';
export {
  generateExcelBasedChangePlan,
  mapRequirementsToProducts,
} from './excel-planning.js';
export {
  applyApprovedProductChange,
  dryRunProductChange,
  verifyProductChange,
} from './apply-verify.js';
export * from './observer-spec-adapter.js';
