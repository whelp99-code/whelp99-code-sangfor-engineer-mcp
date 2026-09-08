export interface DrillFixtureOptions {
  readonly suffix: string;
  readonly auditSecret: string;
  readonly evidenceRoot: string;
}

export interface DrillFixtureIds {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly roleId: string;
  readonly approvalId: string;
  readonly nonceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly evidenceId: string;
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly completedJobId: string;
  readonly indeterminateJobId: string;
  readonly capabilityJti: string;
  readonly indeterminateJti: string;
  readonly epoch: number;
  readonly evidenceObjectPath: string;
  readonly evidenceObjectHash: string;
  readonly auditHeadHash: string;
}

export declare function seedDrillFixture(sql: unknown, options: DrillFixtureOptions): Promise<DrillFixtureIds>;
export declare function dropDrillFixture(sql: unknown, ids: DrillFixtureIds): Promise<void>;
