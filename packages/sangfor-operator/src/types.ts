import type { BrowserExecutionPort } from '../../sangfor-browser-contracts/src/index.js';
import type { ConsoleAction } from '../../shared/src/index.js';

export type OperatorMode =
  | 'mock'
  | 'lab'
  | 'poc'
  | 'customer_readonly'
  | 'customer_write'
  | 'production';

export interface OperatorBrowserOptions {
  cdpEndpoint?: string;
  useLocalBrowser?: boolean;
  cdpPort?: number;
  startIfMissing?: boolean;
  headless?: boolean;
}

export interface OperatorSession {
  id: string;
  product: string;
  mode: OperatorMode;
  targetUrl?: string;
  browser?: OperatorBrowserOptions;
  status:
    | 'pending'
    | 'running'
    | 'waiting_approval'
    | 'verification_required'
    | 'completed'
    | 'failed'
    | 'cancelled';
  approvedChangeTicketId?: string;
  rollbackPlanId?: string;
  cdpPort?: number;
  credentials?: { username: string; password: string };
  loggedIn?: boolean;
}

export interface LiveExecutionApproval {
  approvedBy: string;
  approvalToken: string;
  changeTicketId: string;
  rollbackPlanId: string;
  nonce: string;
  expiresAt: string;
  maintenanceWindow?: string;
}

export interface MenuPathStep {
  menu: string;
  submenu?: string;
}

export interface FormField {
  type: 'text' | 'password' | 'select' | 'checkbox' | 'textarea' | 'combobox' | 'radio';
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
  value?: string;
  options?: string[];
  index?: number;
}

export interface LiveConsoleActionInput {
  sessionId: string;
  action: ConsoleAction;
  approval?: LiveExecutionApproval;
  menuPath?: MenuPathStep[];
  formFields?: FormField[];
  executionPort?: BrowserExecutionPort;
}
