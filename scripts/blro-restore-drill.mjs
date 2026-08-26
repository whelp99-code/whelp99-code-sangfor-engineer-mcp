#!/usr/bin/env node
// BLRO restore drill: prove the backup is a backup, in a scratch target that can never be production.
//
//   node scripts/blro-restore-drill.mjs --backup-dir <dir> --backup-id <id> \
//     --public-key <ed25519.pub.pem> --scratch-target postgresql://…/blro_scratch_<name>
//
// There is no production target path in this program. The only database it may create or drop is
// one whose name carries the reserved scratch prefix, on a loopback host, that is not the source.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { canonicalJson } from './lib/blro-backup-manifest.mjs';
import {
  assertScratchTarget, BlroRuntimeError, monotonicNowMs, parseConnection, parseFlags, redactTarget,
} from './lib/blro-backup-runtime.mjs';
import { applyRecoveryPolicy, proveReplayRefused } from './lib/blro-recovery-policy.mjs';
import {
  BlroRestoreVerifyError, recaptureState, verifyBackupBeforeRestore, verifyPreRecoveryState,
  verifySchemaCompatibility,
} from './lib/blro-restore-verify.mjs';
import { withScratchRestore } from './lib/blro-scratch-restore.mjs';
import {
  buildDrillReceipt, DRILL_PASS_SENTINEL, RTO_BUDGET_MS, signDrillReceipt,
} from './lib/blro-drill-receipt.mjs';

const VALUE_FLAGS = ['--backup-dir', '--backup-id', '--public-key', '--scratch-target', '--signing-key', '--evidence-root', '--receipt-out'];
const BOOLEAN_FLAGS = [];

export function parseDrillCli(argv) {
  const { values } = parseFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);
  for (const required of ['--backup-dir', '--backup-id', '--public-key', '--scratch-target', '--signing-key']) {
    if (!values.has(required)) throw new BlroRuntimeError('BLRO_DRILL_ARGUMENT_REQUIRED', required);
  }
  return {
    backupDir: values.get('--backup-dir'),
    backupId: values.get('--backup-id'),
    publicKeyPath: values.get('--public-key'),
    scratchTarget: values.get('--scratch-target'),
    signingKeyPath: values.get('--signing-key'),
    evidenceRoot: values.get('--evidence-root') ?? 'data/evidence',
    receiptOut: values.get('--receipt-out'),
  };
}

function workingTreeMigrations() {
  return readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function runDrill(options) {
  const startedAt = monotonicNowMs();
  const sourceUrl = process.env['BLRO_BACKUP_DATABASE_URL']?.trim();
  const adminUrl = process.env['BLRO_SCRATCH_ADMIN_DATABASE_URL']?.trim();
  if (!sourceUrl) throw new BlroRuntimeError('BLRO_BACKUP_DATABASE_URL_REQUIRED');
  if (!adminUrl) throw new BlroRuntimeError('BLRO_SCRATCH_ADMIN_DATABASE_URL_REQUIRED');
  const source = parseConnection(sourceUrl, 'BLRO_BACKUP_DATABASE_URL');
  const admin = parseConnection(adminUrl, 'BLRO_SCRATCH_ADMIN_DATABASE_URL');
  const target = assertScratchTarget(parseConnection(options.scratchTarget, '--scratch-target'), source);

  // ── Gates, all before any DDL ────────────────────────────────────────────
  const manifest = verifyBackupBeforeRestore({
    manifestPath: join(options.backupDir, `${options.backupId}.manifest.json`),
    dumpPath: join(options.backupDir, `${options.backupId}.dump`),
    publicKeyPath: options.publicKeyPath,
    evidenceRoot: options.evidenceRoot,
  });
  verifySchemaCompatibility(manifest, workingTreeMigrations());

  await withScratchRestore({
    admin,
    target,
    dumpPath: join(options.backupDir, `${options.backupId}.dump`),
  }, async (scratch) => {
    const { recaptured, recovery } = await verifyPreRecoveryState(scratch, manifest, options.evidenceRoot);
    const policy = await applyRecoveryPolicy(scratch, {
      projectIds: manifest.epochs.map((epoch) => epoch.projectId),
      tenantId: manifest.epochs.length > 0 ? await tenantOf(scratch, manifest.epochs[0].projectId) : '',
      actorId: null,
      at: new Date().toISOString(),
      backupId: manifest.backupId,
      recoveryPointLsn: manifest.postgres.recoveryPoint.lsn,
      auditSecret: requireAuditSecret(),
    });

    const replay = [];
    for (const epoch of manifest.epochs) {
      const outstandingApproval = manifest.authority.outstandingApprovals.find((approval) => approval.projectId === epoch.projectId);
      const outstandingNonce = manifest.authority.outstandingNonces.find((nonce) => nonce.projectId === epoch.projectId);
      const job = manifest.authority.remoteJobs.find((candidate) => candidate.projectId === epoch.projectId);
      if (!outstandingApproval || !outstandingNonce || !job) continue;
      replay.push({
        projectId: epoch.projectId,
        refusals: await proveReplayRefused(scratch, epoch.projectId, {
          signedEpoch: epoch.epoch,
          approvalId: outstandingApproval.id,
          nonceId: outstandingNonce.id,
          capabilityJti: job.capabilityJti,
        }),
      });
    }

    const postPolicy = await recaptureState(scratch, options.evidenceRoot);
    const receipt = signDrillReceipt(buildDrillReceipt({
      manifest, recovery, policy, replay, recaptured, postPolicy,
      target: redactTarget(target),
      source: redactTarget(source),
      rtoMs: monotonicNowMs() - startedAt,
    }), options.signingKeyPath);
    if (options.receiptOut !== undefined) {
      writeFileSync(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    process.stdout.write(`${canonicalJson({
      backupId: receipt.backupId,
      target: redactTarget(target),
      tables: manifest.tables.length,
      rtoMs: Math.round(receipt.drill.rtoMs),
      rtoBudgetMs: RTO_BUDGET_MS,
      recoveryPoint: recovery.recoveryPoint,
      policy,
    })}\n${DRILL_PASS_SENTINEL}\n`);
  });
}

function requireAuditSecret() {
  const secret = process.env['SANGFOR_BLRO_AUDIT_SECRET']?.trim();
  if (!secret || secret.length < 32) throw new BlroRuntimeError('BLRO_DRILL_AUDIT_SECRET_REQUIRED');
  return secret;
}

async function tenantOf(sql, projectId) {
  const [row] = await sql.$queryRawUnsafe(`SELECT "tenantId" FROM "BlroProject" WHERE "id"=$1`, projectId);
  if (!row) throw new BlroRestoreVerifyError('BLRO_DRILL_PROJECT_TENANT_MISSING', projectId);
  return row.tenantId;
}

if (process.argv[1]?.endsWith('blro-restore-drill.mjs')) {
  runDrill(parseDrillCli(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { runDrill };
