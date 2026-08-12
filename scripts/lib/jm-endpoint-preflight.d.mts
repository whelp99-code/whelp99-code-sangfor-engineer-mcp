export type JmPreflightStatus = 'PASS' | 'FAIL';

export interface JmPreflightCheck {
  id: string;
  status: JmPreflightStatus;
  detail: string;
}

export interface JmPreflightReport {
  ready: boolean;
  exitCode: 0 | 1;
  reasons: string[];
  checks: JmPreflightCheck[];
  summary: string;
}

export interface JmPreflightProbes {
  executableExists?: (path: string) => boolean;
  cdpEndpointOrigin?: (port: number) => string | undefined;
  nodeMajor?: () => number;
}

export interface JmPreflightInput {
  env: Record<string, string | undefined>;
  probes?: JmPreflightProbes;
}

export function isLoopbackTarget(rawUrl: string): boolean;

export function evaluateJmEndpointPreflight(input: JmPreflightInput): JmPreflightReport;
