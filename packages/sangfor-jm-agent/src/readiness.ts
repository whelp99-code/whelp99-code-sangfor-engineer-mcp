export const JM_READINESS_REASONS = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  TRUST_INVALID: 'TRUST_INVALID',
  CAPABILITY_VERIFIER_INVALID: 'CAPABILITY_VERIFIER_INVALID',
  GRANT_SNAPSHOT_INVALID: 'GRANT_SNAPSHOT_INVALID',
  JOURNAL_UNAVAILABLE: 'JOURNAL_UNAVAILABLE',
  EXECUTION_PREFLIGHT_FAILED: 'EXECUTION_PREFLIGHT_FAILED',
  DRAINING: 'DRAINING',
} as const;

export type JmReadinessReason =
  (typeof JM_READINESS_REASONS)[keyof typeof JM_READINESS_REASONS];

export type JmReadinessCheck = {
  readonly ok: boolean;
  readonly reason?: JmReadinessReason;
};

export type JmReadinessChecks = {
  readonly config: JmReadinessCheck;
  readonly trust: JmReadinessCheck;
  readonly capabilityVerifier: JmReadinessCheck;
  readonly grantSnapshot: JmReadinessCheck;
  readonly journal: JmReadinessCheck;
  readonly executionPreflight: JmReadinessCheck;
  readonly drain: JmReadinessCheck;
};

export type JmReadiness = {
  readonly ok: boolean;
  readonly schemaVersion: 'jm-browser-agent-readiness.v1';
  readonly checks: JmReadinessChecks;
};

export type JmLivenessState = 'running' | 'draining' | 'closed' | 'failed';

export type JmLiveness = {
  readonly ok: boolean;
  readonly schemaVersion: 'jm-browser-agent-liveness.v1';
  readonly state: JmLivenessState;
};

export function readinessFrom(checks: JmReadinessChecks): JmReadiness {
  return {
    ok: Object.values(checks).every((check) => check.ok),
    schemaVersion: 'jm-browser-agent-readiness.v1',
    checks,
  };
}

export function firstReadinessFailure(readiness: JmReadiness): JmReadinessReason | undefined {
  for (const check of Object.values(readiness.checks)) {
    if (!check.ok && check.reason) return check.reason;
  }
  return undefined;
}

export function livenessFrom(state: JmLivenessState): JmLiveness {
  // A failed drain leaves work outstanding: the process is emphatically not
  // healthy, and must never be reported as a clean close.
  return {
    ok: state === 'running' || state === 'draining',
    schemaVersion: 'jm-browser-agent-liveness.v1',
    state,
  };
}

export const okCheck: JmReadinessCheck = { ok: true };

export function failedCheck(reason: JmReadinessReason): JmReadinessCheck {
  return { ok: false, reason };
}
