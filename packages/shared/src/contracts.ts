import type { ProductCode } from './product-catalog.js';

export type ProjectType = 'deployment' | 'poc' | 'migration' | 'dr' | 'troubleshooting' | 'policy_design' | 'monitoring';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface ProjectInput {
  customerName: string;
  product?: string;
  version?: string;
  projectType?: ProjectType | string;
  environment?: Record<string, unknown>;
  requirements?: string[];
  constraints?: string[];
}

export interface ProjectAnalysis {
  customerName: string;
  detectedProduct: ProductCode;
  detectedVersion?: string;
  projectType: ProjectType;
  riskLevel: RiskLevel;
  missingInputs: string[];
  assumptions: string[];
  recommendedKnowledgeQueries: string[];
}

export interface KnowledgeChunk {
  id: string;
  sourceType: 'manual' | 'wiki' | 'lesson' | 'pattern';
  product: ProductCode;
  version?: string;
  title: string;
  section?: string;
  text: string;
  trustLevel: 'official' | 'internal' | 'draft' | 'needs_review' | 'customer';
}

export interface ConfigStep {
  id: string;
  title: string;
  description: string;
  product: ProductCode;
  phase: 'precheck' | 'configure' | 'validate' | 'rollback';
  approvalRequired: boolean;
  riskLevel: RiskLevel;
  references: string[];
}

export interface ConfigPlan {
  id: string;
  customerName: string;
  product: ProductCode;
  version?: string;
  planTitle: string;
  planSummary: string;
  riskLevel: RiskLevel;
  precheck: ConfigStep[];
  steps: ConfigStep[];
  approvalRequiredSteps: ConfigStep[];
  rollbackPlan: ConfigStep[];
  validationPlan: ConfigStep[];
  manualReferences: KnowledgeChunk[];
  wikiReferences: KnowledgeChunk[];
  lessonReferences: KnowledgeChunk[];
}

export interface ApprovalDecision {
  required: boolean;
  riskLevel: RiskLevel;
  reason: string;
}

export interface ConsoleAction {
  type: 'navigate' | 'click' | 'type' | 'select' | 'scroll' | 'screenshot' | 'wait';
  target?: string;
  value?: string;
  dryRun?: boolean;
}

export interface ConsoleActionResult {
  ok: boolean;
  dryRun: boolean;
  approvalRequired: boolean;
  message: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
}
