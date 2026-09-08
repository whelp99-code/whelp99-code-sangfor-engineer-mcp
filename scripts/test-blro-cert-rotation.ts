import {
  assessIncident,
  assessInstallationIdentity,
  assessReadiness,
  assessRevocation,
  assessRollout,
  assessRotation,
  containEmergency,
} from './lib/blro-enrollment-policy.js';

const checks = [
  assessInstallationIdentity({ installationId: 'task-31-jm', identityCount: 1, apply: false }),
  assessRotation({ installationId: 'task-31-jm', identityCount: 1, overlapSeconds: 600, apply: false }),
  assessRevocation({ installationId: 'task-31-jm', observationAgeSeconds: 60, apply: false }),
  assessRollout({ blroVersion: { major: 1, minor: 1 }, jmVersion: { major: 1, minor: 0 }, blroReady: true }),
  assessReadiness({ blroReady: true, writesContained: true }),
  containEmergency('task-31-incident'),
  assessIncident({
    operation: 'incident', jobId: 'task-31-job', dispatchState: 'INDETERMINATE', mutationAttempted: true,
  }),
  assessIncident({
    operation: 'reconcile', jobId: 'task-31-job', dispatchState: 'INDETERMINATE',
    mutationAttempted: true, readBack: 'INDETERMINATE',
  }),
] as const;

const expectedStatuses = ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'CONTAINED', 'INCIDENT', 'REFUSED'] as const;
if (!checks.every((check, index) => check['status'] === expectedStatuses[index])) {
  process.stderr.write(`${JSON.stringify({ status: 'REFUSED', reason: 'BLRO_CERT_ROTATION_DRIVER_ASSERTION_FAILED' })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    execution: 'NOT_RUN', deviceAction: false, checks: checks.map((check) => check['status']),
  })}\nBLRO_CERT_ROTATION_PASS\n`);
}
