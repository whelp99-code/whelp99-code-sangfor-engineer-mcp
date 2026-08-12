export type JmInstallMode = 'install' | 'doctor';

export interface JmInstallStep {
  id: string;
  title: string;
  command: string;
  detail: string;
  readOnly: boolean;
  skipped: boolean;
  requiresCustomerAccess: false;
  mutatesDevice: false;
}

export interface JmInstallHost {
  platform: string;
  arch: string;
  nodeMajor: number;
}

export interface JmInstallPlan {
  mode: JmInstallMode;
  readOnly: boolean;
  supported: boolean;
  requiresCustomerAccess: false;
  host: JmInstallHost;
  reasons: string[];
  warnings: string[];
  steps: JmInstallStep[];
  summary: string;
}

export interface JmInstallInput {
  host: JmInstallHost;
  env: Record<string, string | undefined>;
  mode?: JmInstallMode;
}

export function planJmEndpointInstall(input: JmInstallInput): JmInstallPlan;
