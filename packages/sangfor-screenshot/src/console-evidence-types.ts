import type { BrowserExecutionPort } from '../../sangfor-browser-contracts/src/index.js';
import type { AuditLedger } from '../../sangfor-hci-client/src/index.js';
import type { ProductCode } from '../../shared/src/index.js';

export interface MenuPathStep {
  menu: string;
  submenu?: string;
}

export interface ConsoleCaptureRequest {
  reqId: string;
  menuLabel: string;
  menuPath?: MenuPathStep[];
  url?: string;
}

export interface CaptureConsoleEvidenceInput {
  product: ProductCode;
  captures: ConsoleCaptureRequest[];
  outputDir: string;
  dateStamp?: string;
  engagementId?: string;
}

export interface ConsoleCaptureItemResult {
  reqId: string;
  menuLabel: string;
  filePath: string;
  sha256: string | null;
  capturedAt: string;
  ok: boolean;
  error?: string;
}

export interface CaptureConsoleEvidenceResult {
  runId: string;
  outputDir: string;
  captures: ConsoleCaptureItemResult[];
  ledgerPath: string;
  chainOk: boolean;
}

export interface CaptureConsoleEvidenceDeps {
  ledger?: AuditLedger;
  executionPort?: BrowserExecutionPort;
  sessionId?: string;
  origin?: string;
  materializeArtifact?: (artifactRef: string, filePath: string) => Promise<void>;
}

export interface CaptureLedgerFileCheck {
  filePath: string;
  recordedHash: string | null;
  currentHash: string | null;
  match: boolean;
  note?: string;
}

export interface VerifyCaptureLedgerResult {
  runId: string;
  chainOk: boolean;
  files: CaptureLedgerFileCheck[];
  allMatch: boolean;
}
