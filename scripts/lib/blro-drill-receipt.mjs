// Signed receipt for one BLRO restore drill.
//
// The receipt is what makes a drill auditable a quarter later: it names the exact backup, the
// recovery point, what the policy spent, what it preserved, the replay refusals it proved, and the
// measured RTO. It is signed with the same Ed25519 task key path and carries no credentials.
import { z } from 'zod';
import {
  assertNoSecretMaterial, backupManifestSchema, canonicalJson, publicKeyDigest, sha256OfString,
} from './blro-backup-manifest.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DRILL_PASS_SENTINEL = 'BLRO_RESTORE_DRILL_PASS';
export const DRILL_RECEIPT_VERSION = 'blro.restore.drill.receipt/1';
/** 60 minutes, measured on a monotonic clock. */
export const RTO_BUDGET_MS = 60 * 60 * 1000;

export class BlroDrillReceiptError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroDrillReceiptError';
    this.code = code;
  }
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmpty = z.string().min(1);

export const drillReceiptSchema = z.object({
  version: z.literal(DRILL_RECEIPT_VERSION),
  backupId: nonEmpty,
  source: nonEmpty,
  target: nonEmpty,
  verifiedAt: z.string().datetime(),
  backup: z.object({
    manifestPayloadSha256: sha256Hex,
    dumpSha256: sha256Hex,
    recoveryPoint: backupManifestSchema.shape.postgres.shape.recoveryPoint,
    rpo: backupManifestSchema.shape.rpo,
  }).strict(),
  verified: z.object({
    tables: z.number().int().positive(),
    committedRows: z.number().int().nonnegative(),
    relationships: z.number().int().nonnegative(),
    auditChains: z.number().int().nonnegative(),
    evidenceObjects: z.number().int().nonnegative(),
    equalityProblems: z.literal(0),
  }).strict(),
  policy: z.array(z.object({
    projectId: nonEmpty,
    epoch: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    spentApprovals: z.number().int().nonnegative(),
    spentNonces: z.number().int().nonnegative(),
    auditSeq: z.number().int().nonnegative(),
    auditHash: sha256Hex,
    preservedJobs: z.number().int().nonnegative(),
  }).strict()),
  preserved: z.object({
    indeterminate: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    remoteJobDigest: sha256Hex,
  }).strict(),
  replayRefusals: z.array(z.object({
    projectId: nonEmpty,
    refusals: z.array(z.object({ kind: nonEmpty, reason: nonEmpty }).passthrough()).min(1),
  }).strict()),
  drill: z.object({
    rtoMs: z.number().nonnegative(),
    rtoBudgetMs: z.literal(RTO_BUDGET_MS),
    withinBudget: z.literal(true),
    sentinel: z.literal(DRILL_PASS_SENTINEL),
  }).strict(),
  signature: backupManifestSchema.shape.signature,
}).strict();

/**
 * Build the receipt body from the drill's observations.
 * Every count here is read from the recaptured state, never restated from intent — and the RTO
 * budget is enforced by construction: over budget throws rather than emitting `withinBudget:false`.
 */
export function buildDrillReceipt(input) {
  if (input.rtoMs > RTO_BUDGET_MS) {
    throw new BlroDrillReceiptError('BLRO_DRILL_RTO_EXCEEDED', `${Math.round(input.rtoMs)}ms > ${RTO_BUDGET_MS}ms`);
  }
  return {
    version: DRILL_RECEIPT_VERSION,
    backupId: input.manifest.backupId,
    source: input.source,
    target: input.target,
    verifiedAt: new Date().toISOString(),
    backup: {
      manifestPayloadSha256: input.manifest.signature.payloadSha256,
      dumpSha256: input.manifest.dump.sha256,
      recoveryPoint: input.manifest.postgres.recoveryPoint,
      rpo: input.manifest.rpo,
    },
    verified: {
      tables: input.recaptured.tables.length,
      committedRows: input.recovery.committedRows,
      relationships: input.recaptured.relationships.length,
      auditChains: input.recaptured.auditHeads.length,
      evidenceObjects: input.recaptured.evidenceObjects.length,
      equalityProblems: 0,
    },
    policy: input.policy,
    preserved: {
      indeterminate: input.postPolicy.authority.indeterminateCount,
      completed: input.postPolicy.authority.completedCount,
      remoteJobDigest: sha256OfString(canonicalJson(input.postPolicy.authority.remoteJobs)),
    },
    replayRefusals: input.replay,
    drill: {
      rtoMs: input.rtoMs,
      rtoBudgetMs: RTO_BUDGET_MS,
      withinBudget: true,
      sentinel: DRILL_PASS_SENTINEL,
    },
  };
}

/** Sign the receipt with the task Ed25519 key. The private key never enters the output. */
export function signDrillReceipt(body, privateKeyPath) {
  const key = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new BlroDrillReceiptError('BLRO_DRILL_RECEIPT_KEY_ALGORITHM_REFUSED', key.asymmetricKeyType ?? 'unknown');
  }
  const payload = canonicalJson(body);
  assertNoSecretMaterial(payload, 'drill receipt payload');
  const receipt = drillReceiptSchema.parse({
    ...body,
    signature: {
      algorithm: 'ed25519',
      publicKeySpkiSha256: publicKeyDigest(privateKeyPath),
      payloadSha256: sha256OfString(payload),
      value: sign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
    },
  });
  assertNoSecretMaterial(canonicalJson(receipt), 'signed drill receipt');
  return receipt;
}
