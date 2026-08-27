import type { ReplicaConfig } from './blro-two-replica-types.js';
import type { TwoReplicaFixture } from './blro-two-replica-fixture.js';
import { ReplicaHarnessError, ReplicaProcess } from './blro-two-replica-runner.js';

export async function runCoreScenarios(input: {
  readonly fixture: TwoReplicaFixture;
  readonly replicas: readonly [ReplicaProcess, ReplicaProcess];
  readonly attempts: number;
}): Promise<{ readonly calls: number; readonly jobs: number; readonly jtis: number }> {
  const [first, second] = input.replicas;
  const concurrentExecution = input.fixture.armJm();
  const bodies = new Map<string, string>();
  const submissions = Array.from({ length: input.attempts }, (_, index) => {
    const jti = `todo28-jti-${String(index)}`;
    const bodyText = input.fixture.body({ requestId: 'todo28-concurrent',
      jobId: 'todo28-concurrent', jti });
    bodies.set(jti, bodyText);
    return (index % 2 === 0 ? first : second).submit({ bodyText });
  });
  await Promise.race([
    Promise.all(submissions.map((submission) => Promise.race([
      submission.events.reserved, submission.events.waiting,
    ]))),
    abortAfter(30_000),
  ]);
  concurrentExecution.release();
  const outputs = await Promise.all(submissions.map((submission) => submission.result));
  invariant(outputs.every((result) => result.status === 'INDETERMINATE'), 'CONCURRENT_OUTCOME_DIVERGED');
  invariant(input.fixture.jmCalls() === 1, 'CONCURRENT_EXECUTOR_COUNT');
  const retained = JSON.stringify(outputs[0]);
  invariant(outputs.every((result) => JSON.stringify(result) === retained), 'RETAINED_RESULT_DIVERGED');
  const counts = await input.fixture.queryCounts();
  invariant(counts.jobs === 1 && counts.jtis === 1, 'CONCURRENT_AUTHORITY_COUNT');

  const conflict = input.fixture.body({ requestId: 'todo28-conflict', jobId: 'todo28-concurrent',
    jti: 'todo28-conflict-jti', digestVariant: 'Different' });
  const conflictResult = await second.submit({ bodyText: conflict }).result;
  invariant(conflictResult.status === 'REFUSED' && input.fixture.jmCalls() === 1, 'CONFLICT_LEAK_OR_DISPATCH');
  const unsupported = bodies.values().next().value?.replace(
    'browser-execution-request.v1', 'browser-execution-request.v2');
  const crossScope = bodies.values().next().value?.replace(
    '"tenantId":"task26-tenant"', '"tenantId":"foreign-tenant"');
  if (!unsupported || !crossScope) throw new ReplicaHarnessError('BOUNDARY_FIXTURE_MISSING');
  const opaque = await Promise.all([
    first.submit({ bodyText: unsupported }).result,
    second.submit({ bodyText: crossScope }).result,
  ]);
  invariant(opaque.every((result) => result.status === 'REFUSED') && input.fixture.jmCalls() === 1,
    'UNSUPPORTED_OR_CROSS_SCOPE_LEAKED');

  const precommit = input.fixture.body({ requestId: 'todo28-precommit',
    jobId: 'todo28-precommit', jti: 'todo28-precommit-jti' });
  const dying = first.submit({ bodyText: precommit, failpoint: 'pre_commit' });
  await Promise.race([dying.events.reserved, abortAfter(10_000)]);
  await first.kill();
  await expectReplicaDeath(dying.result);
  const recovered = await second.submit({ bodyText: precommit }).result;
  invariant(recovered.status === 'INDETERMINATE' && input.fixture.jmCalls() === 2,
    'PRECOMMIT_ROLLBACK_FAILED');
  await first.start();

  const postcommit = input.fixture.body({ requestId: 'todo28-postcommit',
    jobId: 'todo28-postcommit', jti: 'todo28-postcommit-jti' });
  const lost = first.submit({ bodyText: postcommit, failpoint: 'post_commit' });
  await Promise.race([lost.events['dispatch-boundary'], abortAfter(10_000)]);
  await first.kill();
  await expectReplicaDeath(lost.result);
  const postcommitRestart = input.fixture.body({ requestId: 'todo28-postcommit',
    jobId: 'todo28-postcommit', jti: 'todo28-postcommit-restart-jti' });
  const tombstone = await second.submit({ bodyText: postcommitRestart }).result;
  invariant(tombstone.status === 'INDETERMINATE' && input.fixture.jmCalls() === 2,
    'POSTCOMMIT_REDISPATCHED');
  await first.start();

  const disconnectedExecution = input.fixture.armJm();
  const disconnectBody = input.fixture.body({ requestId: 'todo28-disconnect',
    jobId: 'todo28-disconnect', jti: 'todo28-disconnect-jti' });
  const disconnected = first.submit({ bodyText: disconnectBody });
  await Promise.race([disconnectedExecution.started, abortAfter(10_000)]);
  await first.kill();
  disconnectedExecution.release();
  await expectReplicaDeath(disconnected.result);
  await second.kill();
  await Promise.all([first.start(), second.start()]);
  const disconnectedRestart = input.fixture.body({ requestId: 'todo28-disconnect',
    jobId: 'todo28-disconnect', jti: 'todo28-disconnect-restart-jti' });
  const sticky = await second.submit({ bodyText: disconnectedRestart }).result;
  invariant(sticky.status === 'INDETERMINATE' && input.fixture.jmCalls() === 3,
    'POSTDISPATCH_DISCONNECT_RETRIED');

  await assertDependencyFailures(input.fixture, input.replicas);
  const consumedJti = await input.fixture.winnerJti('todo28-concurrent');
  const consumedBody = bodies.get(consumedJti);
  if (!consumedBody) throw new ReplicaHarnessError('WINNER_BODY_MISSING');
  const replay = await first.submit({ bodyText: consumedBody }).result;
  invariant(replay.status === 'REFUSED' && input.fixture.jmCalls() === 3, 'JTI_REPLAY_ACCEPTED');
  await input.fixture.revoke();
  const revokedBody = input.fixture.body({ requestId: 'todo28-revoked',
    jobId: 'todo28-revoked', jti: 'todo28-revoked-jti' });
  const revoked = await second.submit({ bodyText: revokedBody }).result;
  invariant(revoked.status === 'REFUSED' && input.fixture.jmCalls() === 3, 'REVOCATION_NOT_OBSERVED');
  return { calls: input.fixture.jmCalls(), ...(await input.fixture.queryCounts()) };
}

async function assertDependencyFailures(
  fixture: TwoReplicaFixture,
  replicas: readonly [ReplicaProcess, ReplicaProcess],
): Promise<void> {
  const [first, second] = replicas;
  await fixture.stopJm();
  const unavailable = await Promise.all([first.readiness(), second.readiness()]);
  invariant(unavailable.every((status) => status === 503), 'JM_READINESS_REMAINED_AVAILABLE');
  const bodyText = fixture.body({ requestId: 'todo28-jm-unavailable',
    jobId: 'todo28-jm-unavailable', jti: 'todo28-jm-unavailable-jti' });
  const output = await first.submit({ bodyText }).result;
  invariant(output.status === 'REFUSED' && fixture.jmCalls() === 3, 'JM_READINESS_LOSS_DISPATCHED');
  await fixture.startJm();
  invariant((await Promise.all([first.readiness(), second.readiness()])).every((status) => status === 200),
    'JM_READINESS_DID_NOT_RECOVER');
  await assertUnavailableReplica({ ...first.config, signingPrivateKey: 'lost' }, first.entrypoint);
  await assertUnavailableReplica({ ...first.config, trustedIssuerBundle: '' }, first.entrypoint);
  await assertUnavailableReplica({ ...first.config,
    databaseUrl: 'postgresql://lost:lost@127.0.0.1:1/lost' }, first.entrypoint);
  invariant(fixture.jmCalls() === 3, 'DEPENDENCY_LOSS_DISPATCHED');
}

async function assertUnavailableReplica(config: ReplicaConfig, entrypoint: string): Promise<void> {
  const replica = new ReplicaProcess(config, entrypoint);
  try {
    await replica.start();
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
  await replica.stop();
  throw new ReplicaHarnessError('INVALID_DEPENDENCY_REPLICA_READY');
}

async function expectReplicaDeath(result: Promise<unknown>): Promise<void> {
  await result.catch((error: unknown) => {
    if (!(error instanceof ReplicaHarnessError)) throw error;
  });
}
function abortAfter(milliseconds: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = AbortSignal.timeout(milliseconds);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
function invariant(value: boolean, code: string): asserts value {
  if (!value) throw new ReplicaHarnessError(code);
}
