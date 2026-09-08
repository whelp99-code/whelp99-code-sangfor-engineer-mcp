import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  AUTHORITY_ADAPTER_POLICIES,
  AUTHORITY_MANIFEST,
  AuthorityCutoverError,
  AuthorityCutoverMachine,
  CutoverState,
  digestTargetDigestMap,
  PostgresCutoverRepository,
  PostgresLocalWriteIntentRepository,
  resolveCutoverAdapter,
  type AuthorityAggregate,
} from '../packages/sangfor-authority/src/index.js';

const COMMANDS = ['status', 'plan', 'backfill', 'shadow', 'freeze', 'promote', 'rollback', 'read-intent', 'reconcile'] as const;
const authoritativeAggregates = AUTHORITY_MANIFEST.entries
  .filter((entry) => entry.classification === 'authoritative').map((entry) => entry.aggregate);
const cliSchema = z.object({
  command: z.enum(COMMANDS), tenantId: z.string().min(1).optional(), projectId: z.string().min(1),
  aggregate: z.string(), actorId: z.string().min(1).optional(), sourceRoot: z.string().min(1).optional(),
  sourceFiles: z.array(z.string().min(1)).optional(),
  expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedTargetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedHighWaterMark: z.string().min(1).optional(), expectedOperationDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedBeforeDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), expectedTargetPaths: z.array(z.string().min(1)).optional(), expectedAfterDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  writeId: z.string().min(1).optional(), resolution: z.enum(['COMPLETED', 'ABORTED']).optional(), expectedRevision: z.number().int().nonnegative().optional(),
  expectedEpoch: z.number().int().nonnegative().optional(), at: z.string().datetime().optional(), apply: z.boolean(),
}).strict();
export type AuthorityCutoverCliInput = Omit<z.infer<typeof cliSchema>, 'aggregate'> & {
  readonly aggregate: AuthorityAggregate;
};

const isAuthoritativeAggregate = (value: string): value is AuthorityAggregate =>
  authoritativeAggregates.some((aggregate) => aggregate === value);

export function parseAuthorityCutoverCli(argv: readonly string[]): AuthorityCutoverCliInput {
  const values = new Map<string, string>(); let command: (typeof COMMANDS)[number] = 'plan'; let apply = false;
  const valueFlags = new Set([
    '--tenant', '--project', '--aggregate', '--actor', '--source-root', '--source-files', '--expected-source-digest',
    '--expected-target-digest', '--expected-hwm', '--expected-operation-digest', '--expected-before-digest',
    '--expected-after-digest', '--expected-paths', '--write-id', '--resolution', '--expected-revision', '--expected-epoch', '--at',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { if (apply) throw new AuthorityCutoverError('CUTOVER_CLI_DUPLICATE_ARGUMENT'); apply = true; continue; }
    const parsedCommand = COMMANDS.find((candidate) => candidate === argument);
    if (parsedCommand) { command = parsedCommand; continue; }
    if (argument && valueFlags.has(argument)) {
      if (values.has(argument)) throw new AuthorityCutoverError('CUTOVER_CLI_DUPLICATE_ARGUMENT', [argument]);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new AuthorityCutoverError('CUTOVER_CLI_SCOPE_REQUIRED');
      values.set(argument, value); index += 1; continue;
    }
    throw new AuthorityCutoverError('CUTOVER_CLI_UNKNOWN_ARGUMENT', [argument ?? '<missing>']);
  }
  const epochText = values.get('--expected-epoch'); const revisionText = values.get('--expected-revision');
  const parsed = cliSchema.safeParse({
    command, tenantId: values.get('--tenant'), projectId: values.get('--project'),
    aggregate: values.get('--aggregate'), actorId: values.get('--actor'), sourceRoot: values.get('--source-root'),
    sourceFiles: values.get('--source-files')?.split(',').filter(Boolean),
    expectedSourceDigest: values.get('--expected-source-digest'), expectedTargetDigest: values.get('--expected-target-digest'),
    expectedHighWaterMark: values.get('--expected-hwm'), expectedOperationDigest: values.get('--expected-operation-digest'),
    expectedBeforeDigest: values.get('--expected-before-digest'), expectedTargetPaths: values.get('--expected-paths')?.split(',').filter(Boolean),
    expectedAfterDigest: values.get('--expected-after-digest'),
    writeId: values.get('--write-id'), resolution: values.get('--resolution'), expectedRevision: revisionText === undefined ? undefined : Number(revisionText),
    expectedEpoch: epochText === undefined ? undefined : Number(epochText), at: values.get('--at'), apply,
  });
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_CLI_INVALID', parsed.error.issues.map((issue) => issue.message));
  if (!isAuthoritativeAggregate(parsed.data.aggregate)) throw new AuthorityCutoverError('CUTOVER_AGGREGATE_UNSUPPORTED');
  const mutation = !['status', 'plan', 'read-intent'].includes(parsed.data.command);
  if (mutation !== parsed.data.apply) throw new AuthorityCutoverError(mutation ? 'CUTOVER_CLI_APPLY_REQUIRED' : 'CUTOVER_CLI_APPLY_INVALID');
  const policy = AUTHORITY_ADAPTER_POLICIES.find((entry) => entry.aggregate === parsed.data.aggregate);
  if (!policy) throw new AuthorityCutoverError('CUTOVER_POLICY_UNKNOWN');
  if (policy.policy === 'backfill' && parsed.data.command !== 'status' && parsed.data.command !== 'read-intent'
    && (!parsed.data.sourceRoot || !parsed.data.actorId || !parsed.data.tenantId || !parsed.data.sourceFiles?.length)) throw new AuthorityCutoverError('CUTOVER_CLI_ADAPTER_INPUT_REQUIRED');
  if (mutation && (!parsed.data.tenantId || !parsed.data.actorId || !parsed.data.sourceRoot
    || parsed.data.expectedRevision === undefined || parsed.data.expectedEpoch === undefined)) {
    throw new AuthorityCutoverError('CUTOVER_CLI_SCOPE_REQUIRED');
  }
  if (mutation && (!parsed.data.expectedSourceDigest || !parsed.data.expectedTargetDigest || !parsed.data.expectedHighWaterMark)) {
    throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_REQUIRED');
  }
  if (parsed.data.command === 'read-intent' && (!parsed.data.tenantId || !parsed.data.actorId || !parsed.data.sourceRoot
    || !parsed.data.writeId || !parsed.data.expectedOperationDigest || !parsed.data.expectedBeforeDigest)) {
    throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_REQUIRED');
  }
  if (parsed.data.command === 'reconcile' && (!parsed.data.writeId || !parsed.data.resolution || !parsed.data.expectedOperationDigest
    || !parsed.data.expectedBeforeDigest || !parsed.data.expectedAfterDigest || !parsed.data.expectedTargetPaths?.length)) {
    throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_REQUIRED');
  }
  return { ...parsed.data, aggregate: parsed.data.aggregate };
}

function assertCleanSourceRepository(sourceRoot: string): void {
  try {
    execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return; }
  const status = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.trim().length > 0) throw new AuthorityCutoverError('CUTOVER_DIRTY_REPOSITORY');
}

function assertExpected(
  state: Awaited<ReturnType<PostgresCutoverRepository['read']>>,
  input: AuthorityCutoverCliInput,
): void {
  if (input.expectedRevision !== undefined && state.revision !== input.expectedRevision) throw new AuthorityCutoverError('CUTOVER_STALE_REVISION');
  if (input.expectedEpoch !== undefined && state.epoch !== input.expectedEpoch) throw new AuthorityCutoverError('CUTOVER_STALE_EPOCH');
  if (input.expectedSourceDigest !== undefined && state.sourceDigest !== input.expectedSourceDigest) throw new AuthorityCutoverError('CUTOVER_EXPECTED_SOURCE_DIGEST_MISMATCH');
  if (input.expectedTargetDigest !== undefined && state.targetDigest !== input.expectedTargetDigest) throw new AuthorityCutoverError('CUTOVER_EXPECTED_TARGET_DIGEST_MISMATCH');
  if (input.expectedHighWaterMark !== undefined && state.sourceHighWaterMark !== input.expectedHighWaterMark) throw new AuthorityCutoverError('CUTOVER_EXPECTED_HWM_MISMATCH');
}

export async function runAuthorityCutoverCli(input: AuthorityCutoverCliInput): Promise<unknown> {
  if (!process.env.DATABASE_URL) throw new AuthorityCutoverError('CUTOVER_DATABASE_REQUIRED');
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const repository = new PostgresCutoverRepository(prisma);
  const scope = { projectId: input.projectId, aggregate: input.aggregate } as const;
  try {
    const state = await repository.read(scope);
    const policy = AUTHORITY_ADAPTER_POLICIES.find((entry) => entry.aggregate === input.aggregate);
    if (!policy) throw new AuthorityCutoverError('CUTOVER_POLICY_UNKNOWN');
    if (input.command === 'status') return { outcome: 'STATUS', policy, state };
    if (input.command === 'read-intent') {
      const intent = await new PostgresLocalWriteIntentRepository(prisma).read(input.projectId, input.writeId ?? '');
      if (intent.tenantId !== input.tenantId || intent.actorId !== input.actorId || intent.aggregate !== input.aggregate
        || intent.sourceRoot !== resolve(input.sourceRoot ?? '') || intent.operationDigest !== input.expectedOperationDigest
        || digestTargetDigestMap(intent.beforeDigests) !== input.expectedBeforeDigest) {
        throw new AuthorityCutoverError('LOCAL_WRITE_RECONCILE_EXPECTATION_MISMATCH');
      }
      return { outcome: 'LOCAL_WRITE_INTENT', intent };
    }
    if (input.command === 'reconcile') {
      assertExpected(state, input);
      const intent = await new PostgresLocalWriteIntentRepository(prisma).reconcile({
        tenantId: input.tenantId ?? '', projectId: input.projectId, actorId: input.actorId ?? '', aggregate: input.aggregate,
        writeId: input.writeId ?? '', expectedOperationDigest: input.expectedOperationDigest ?? '',
        expectedBeforeDigest: input.expectedBeforeDigest ?? '', expectedAfterDigest: input.expectedAfterDigest ?? '',
        expectedTargetPaths: input.expectedTargetPaths ?? [], resolution: input.resolution ?? 'ABORTED',
      });
      return { outcome: 'LOCAL_WRITE_RECONCILED', intent };
    }
    if (input.aggregate === 'audit' && !process.env.SANGFOR_CHANGE_LEDGER_SECRET) {
      throw new AuthorityCutoverError('CUTOVER_AUDIT_SECRET_REQUIRED');
    }
    const resolved = resolveCutoverAdapter(input.aggregate, {
      database: prisma, tenantId: input.tenantId ?? '', projectId: input.projectId,
      actorId: input.actorId ?? 'postgres-native', sourceRoot: input.sourceRoot ?? '.', expectedFiles: input.sourceFiles ?? [],
      ...(process.env.SANGFOR_CHANGE_LEDGER_SECRET ? { auditSecret: process.env.SANGFOR_CHANGE_LEDGER_SECRET } : {}),
      ...(process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET ? { promotionLedgerSecret: process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET } : {}),
      ...(process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET ? { promotionCheckpointSecret: process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET } : {}),
    });
    const backfillMachine = (): AuthorityCutoverMachine => {
      if (resolved.policy !== 'backfill') throw new AuthorityCutoverError('CUTOVER_TARGET_POLICY_INVALID');
      return new AuthorityCutoverMachine(repository, resolved.source, resolved.target, {
        tenantId: input.tenantId ?? '', actorId: input.actorId ?? '', sourceRoot: input.sourceRoot ?? '.',
      });
    };
    if (input.command === 'plan') {
      const preview = resolved.policy === 'backfill' ? await resolved.source.capture(input.projectId) : undefined;
      return {
        outcome: 'DRY_RUN', policy, state,
        ...(preview ? {
          highWaterMark: preview.highWaterMark, sourceDigest: preview.highWaterMark,
          expectedTargetDigest: preview.highWaterMark, recordCount: preview.records.length,
        } : {}),
      };
    }
    if (input.command === 'shadow') {
      assertExpected(state, input);
      if (resolved.policy !== 'backfill') return { outcome: 'SHADOW_NOT_REQUIRED', policy, state };
      await backfillMachine().verifyShadow(input.projectId);
      return { outcome: 'SHADOW_MATCH', policy, state: await repository.read(scope) };
    }
    if (resolved.policy === 'backfill' && ['backfill', 'freeze'].includes(input.command)) {
      assertCleanSourceRepository(input.sourceRoot ?? '.');
    }
    if (input.command === 'backfill') {
      if (resolved.policy === 'backfill') {
        if (state.revision !== input.expectedRevision || state.epoch !== input.expectedEpoch) throw new AuthorityCutoverError('CUTOVER_STALE_REVISION');
        const snapshot = await resolved.source.capture(input.projectId);
        const digest = snapshot.highWaterMark;
        if (snapshot.highWaterMark !== input.expectedHighWaterMark || digest !== input.expectedSourceDigest
          || input.expectedTargetDigest !== digest) throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_MISMATCH');
      }
      const next = resolved.policy === 'backfill'
        ? await backfillMachine().backfill(input.projectId)
        : await resolved.adapter.prepare(repository, input.expectedEpoch ?? state.epoch);
      return { outcome: 'BACKFILL_APPLIED', policy, state: next };
    }
    if (input.command === 'rollback') {
      if (resolved.policy === 'backfill') {
        assertCleanSourceRepository(input.sourceRoot ?? '.');
        const snapshot = await resolved.source.capture(input.projectId);
        if (snapshot.highWaterMark !== input.expectedHighWaterMark || snapshot.highWaterMark !== input.expectedSourceDigest) {
          throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_MISMATCH');
        }
      }
      assertExpected(state, input);
      if (resolved.policy === 'backfill') return { outcome: 'ROLLED_BACK', state: await backfillMachine().rollback(input.projectId) };
      return { outcome: 'ROLLED_BACK', state: await repository.apply(scope, { kind: 'ROLLBACK', expectedRevision: state.revision }) };
    }
    assertExpected(state, input);
    if (input.command === 'freeze') {
      const at = input.at ?? new Date().toISOString();
      let next;
      if (resolved.policy === 'backfill') next = await backfillMachine().freeze(input.projectId, at);
      else next = await repository.freezeVerified(scope, {
        at, expectedRevision: state.revision,
        verifyFinalParity: resolved.policy === 'postgres_native'
          ? async (transaction) => { if (await resolved.adapter.readinessDigest(transaction) !== state.sourceDigest) throw new AuthorityCutoverError('CUTOVER_NATIVE_TARGET_CHANGED'); }
          : async () => undefined,
      });
      if (resolved.policy === 'invalidate_on_cutover') await resolved.adapter.verifyFrozen(repository, state.epoch);
      return { outcome: 'FROZEN', policy, state: next };
    }
    if (resolved.policy === 'backfill') {
      assertCleanSourceRepository(input.sourceRoot ?? '.');
      const snapshot = await resolved.source.capture(input.projectId);
      if (snapshot.highWaterMark !== input.expectedHighWaterMark || snapshot.highWaterMark !== input.expectedSourceDigest) {
        throw new AuthorityCutoverError('CUTOVER_CLI_EXPECTATION_MISMATCH');
      }
    }
    if (state.state !== CutoverState.FROZEN) throw new AuthorityCutoverError('CUTOVER_STATE_CONFLICT');
    const promoted = await repository.apply(scope, { kind: 'PROMOTE', expectedRevision: state.revision });
    const readBack = await repository.read(scope);
    if (readBack.state !== CutoverState.POSTGRES_PRIMARY || readBack.epoch !== promoted.epoch) throw new AuthorityCutoverError('CUTOVER_PROMOTION_READBACK_FAILED');
    return { outcome: 'BLRO_CUTOVER_PASS', policy, state: readBack };
  } finally { await prisma.$disconnect(); }
}

async function main(): Promise<void> { // no-excuse-ok: catch
  try { process.stdout.write(`${JSON.stringify(await runAuthorityCutoverCli(parseAuthorityCutoverCli(process.argv.slice(2))))}\n`); }
  catch (error) {
    const code = error instanceof AuthorityCutoverError ? error.code : 'INDETERMINATE';
    process.stderr.write(`${JSON.stringify({ outcome: 'INDETERMINATE', code })}\n`); process.exitCode = 1;
  }
}
if (process.argv[1]?.endsWith('blro-migrate-authority.ts')) await main();
