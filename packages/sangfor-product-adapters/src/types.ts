import type { RiskLevel } from '@sangfor/shared';
export type { AdapterProductCode, ProductRegistryEntry, ProductRegistryView, SpecProductMapping } from '@sangfor/learning-strategy';
import type { ProductRegistryView, SpecProductMapping } from '@sangfor/learning-strategy';

export type AutomationProductCode = 'HCI_SCP' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR';
export type RequirementProductCode = AutomationProductCode | 'external_or_manual';
export type AdapterStrategy = 'api-first' | 'webui-first' | 'hybrid';
export type ConfigSource = 'api' | 'webui' | 'api-discovery' | 'hybrid';

export interface ProductCapability {
  id: string;
  title: string;
  collectSections: string[];
  planKeywords: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  menuPath: string[];
  apiEndpointCandidates: string[];
}

export interface ProductAdapter {
  product: AutomationProductCode;
  aliases: string[];
  strategy: AdapterStrategy;
  authMethods: string[];
  apiLikely: boolean;
  apiCatalogStatus: 'ready' | 'discovery_required' | 'document_required';
  menuRoutes: string[];
  capabilities: ProductCapability[];
}

export interface ProductAutomationInput {
  product?: string;
  targetUrl?: string;
  version?: string;
  environment?: 'lab' | 'poc' | 'customer' | 'production';
  preferApi?: boolean;
}

export interface ProductConfigSnapshot {
  id: string;
  product: AutomationProductCode;
  strategy: AdapterStrategy;
  source: ConfigSource;
  targetUrl?: string;
  version?: string;
  collectedAt: string;
  sections: Array<{
    id: string;
    source: ConfigSource;
    status: 'planned' | 'collectable' | 'needs_discovery';
    evidence: string[];
  }>;
  safety: {
    readOnly: true;
    mutationBlocked: true;
  };
}

export interface RequirementAnalysisInput extends ProductAutomationInput {
  requirements: string[];
  currentConfig?: ProductConfigSnapshot | Record<string, unknown>;
}

export interface RequirementTask {
  id: string;
  product: AutomationProductCode;
  excelRowId?: string;
  objective?: string;
  currentGap?: string;
  evidenceNeed?: string[];
  dryRunActions?: string[];
  actualApplySupported?: boolean;
  requirement: string;
  capabilityId: string;
  menuPath: string[];
  apiEndpointCandidates: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  rationale: string;
}

export interface ProductChangePlan {
  id: string;
  product: AutomationProductCode;
  strategy: AdapterStrategy;
  summary: string;
  tasks: RequirementTask[];
  rollbackPlan: string[];
  validationPlan: string[];
  executionGates: string[];
}

export interface ApprovalPayload {
  approvedBy?: string;
  approvalToken?: string;
  changeTicketId?: string;
  rollbackPlanId?: string;
}

export interface ExcelRequirementRow {
  rowNumber: number;
  rowId: string;
  no?: string;
  category?: string;
  solution?: string;
  item?: string;
  specificDetails?: string;
  inspectionResult: Record<string, string>;
  resultScore?: number;
  resultRaw?: string;
  reason?: string;
  assessmentCriteria?: string;
  remark?: string;
  requirement: string;
  evidenceNeed: string[];
  targetControl: string;
  currentGap: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ExcelImportResult {
  id: string;
  filePath: string;
  sheetName: string;
  headerRow: number;
  rows: ExcelRequirementRow[];
  summary: {
    totalRows: number;
    prioritizedRows: number;
    highPriorityRows: number;
  };
}

export interface MappedRequirement extends ExcelRequirementRow {
  mappedProduct: RequirementProductCode;
  mappingReason: string;
  capabilityId?: string;
  menuPath: string[];
  apiEndpointCandidates: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  actualApplySupported: boolean;
}

export interface RequirementMappingResult {
  id: string;
  rows: MappedRequirement[];
  summary: Record<RequirementProductCode, number>;
}

export interface ExcelBasedChangePlan {
  id: string;
  source: 'excel';
  product: 'MULTI_PRODUCT';
  strategy: 'excel-driven-dry-run';
  summary: string;
  workPlan: ExcelWorkPlanItem[];
  tasks: MappedRequirement[];
  dryRunRequired: true;
  mutationPerformed: false;
  stoppedBefore: string[];
  executionGates: string[];
  manualReviewRows: string[];
}

export interface ExcelWorkPlanItem {
  requestId: string;
  excelRowId: string;
  no?: string;
  product: RequirementProductCode;
  menu: string;
  setting: string;
  description: string;
  currentGap: string;
  target: string;
  evidence: string[];
  dryRunAction: string;
  status: 'dry_run_ready' | 'manual_review_required';
  approvalRequired: boolean;
  actualApplySupported: boolean;
}

export type ObserverAdapterProductCode = AutomationProductCode | 'FORTIOS' | 'IOSXE';

export interface AdapterIdentity<C extends ObserverAdapterProductCode = ObserverAdapterProductCode> {
  adapterProduct: C;
  vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
  aliases: string[];
  observerOnlyAliases: string[];
  observerEligible: boolean;
  defaultSpecMapping: SpecProductMapping | null;
  specMappingByVariant: Record<string, SpecProductMapping>;
}

export interface AdapterRegistryEntry<C extends ObserverAdapterProductCode = ObserverAdapterProductCode> {
  identity: AdapterIdentity<C>;
  legacyAdapter: C extends AutomationProductCode ? ProductAdapter : null;
}

export type AdapterRegistry = Record<ObserverAdapterProductCode, AdapterRegistryEntry>;

export interface StrictProductResolveRequest {
  product?: string;
  input?: string;
  adapterProduct?: string;
  productVariant?: string | null;
  registryDigest?: string;
  registry?: ProductRegistryView;
  snapshot?: ProductRegistryView;
}

export interface StrictProductResolveOptions {
  snapshot?: ProductRegistryView;
  registryDigest?: string;
  productVariant?: string | null;
}

export type ProductChangeExecutor = (context: {
  plan: ProductChangePlan;
  approval?: ApprovalPayload;
  environment?: 'lab' | 'poc' | 'customer' | 'production';
  sessionId?: string;
}) => Promise<{ mutationPerformed: boolean; details?: unknown }>;
