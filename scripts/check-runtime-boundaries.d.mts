export type RuntimeBoundaryPolicyCounts = {
  readonly freeze: number;
  readonly deny: number;
  readonly loud_failure: number;
  readonly invalid_report: number;
  readonly INDETERMINATE: number;
};

export type RuntimeBoundaryReport = {
  readonly status: 'pass' | 'fail';
  readonly message: 'RUNTIME_BOUNDARY_INVENTORY_V2_PASS' | 'RUNTIME_BOUNDARY_INVENTORY_V2_FAIL';
  readonly inventoryVersion: 2;
  readonly strictCalls: number;
  readonly unsafeAssertions: number;
  readonly environmentJson: number;
  readonly stale: number;
  readonly duplicate: number;
  readonly unowned: number;
  readonly policyCounts: RuntimeBoundaryPolicyCounts;
  readonly environmentPolicyCounts: RuntimeBoundaryPolicyCounts;
  readonly violations?: readonly string[];
};

export function checkRuntimeBoundaries(options: {
  readonly root: string;
  readonly inventoryPath?: string;
}): RuntimeBoundaryReport;
