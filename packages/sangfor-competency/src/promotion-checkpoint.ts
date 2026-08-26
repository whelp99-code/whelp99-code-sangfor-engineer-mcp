import { createHmac } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomicSync } from '../../shared/src/index.js';
import { z } from 'zod';
import { sha256Schema } from './evidence-primitives.js';
import { PromotionLedgerUnavailableError } from './promotion-ledger-errors.js';

const CHECKPOINT_DOMAIN = 'sangfor.capability-promotion-checkpoint.v1';
export const PROMOTION_GENESIS = 'GENESIS';
export const checkpointHashSchema = z.union([z.literal(PROMOTION_GENESIS), sha256Schema]);
const checkpointSchema = z.object({
  version: z.literal(1),
  eventCount: z.number().int().nonnegative(),
  lastHash: checkpointHashSchema,
  hmac: sha256Schema,
}).strict().readonly();
type PromotionCheckpoint = z.infer<typeof checkpointSchema>;

export function promotionCheckpointPath(ledgerPath: string): string {
  return `${ledgerPath}.head.json`;
}

function checkpointHmac(secret: string, eventCount: number, lastHash: string): string {
  return createHmac('sha256', secret)
    .update(`${CHECKPOINT_DOMAIN}\n1\n${eventCount}\n${lastHash}`, 'utf8')
    .digest('hex');
}

export function assertPromotionSecrets(ledgerSecret: string, checkpointSecret: string): void {
  if (ledgerSecret.length < 32 || checkpointSecret.length < 32 || ledgerSecret === checkpointSecret) {
    throw new PromotionLedgerUnavailableError();
  }
}

export function initializePromotionStore(ledgerPath: string, checkpointSecret: string): void {
  const headPath = promotionCheckpointPath(ledgerPath);
  const ledgerExists = existsSync(ledgerPath);
  const checkpointExists = existsSync(headPath);
  if (ledgerExists !== checkpointExists) throw new PromotionLedgerUnavailableError();
  mkdirSync(dirname(ledgerPath), { recursive: true });
  if (!ledgerExists) {
    writeFileAtomicSync(ledgerPath, '');
    writePromotionCheckpoint(headPath, checkpointSecret, 0, PROMOTION_GENESIS);
  }
}

export function assertPromotionStoreFiles(ledgerPath: string): void {
  try {
    const ledger = lstatSync(ledgerPath);
    const checkpoint = lstatSync(promotionCheckpointPath(ledgerPath));
    if (!ledger.isFile() || ledger.isSymbolicLink() || !checkpoint.isFile() || checkpoint.isSymbolicLink()) {
      throw new PromotionLedgerUnavailableError();
    }
  } catch (error) {
    if (error instanceof PromotionLedgerUnavailableError) throw error;
    throw new PromotionLedgerUnavailableError();
  }
}

export function readPromotionCheckpoint(ledgerPath: string, secret: string): PromotionCheckpoint {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(promotionCheckpointPath(ledgerPath), 'utf8')); }
  catch { throw new PromotionLedgerUnavailableError(); }
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success) throw new PromotionLedgerUnavailableError();
  const checkpoint = parsed.data;
  if (checkpoint.hmac !== checkpointHmac(secret, checkpoint.eventCount, checkpoint.lastHash)) {
    throw new PromotionLedgerUnavailableError();
  }
  return checkpoint;
}

export function assertCheckpointMatches(checkpoint: PromotionCheckpoint, eventHashes: readonly string[]): void {
  const lastHash = eventHashes.at(-1) ?? PROMOTION_GENESIS;
  if (checkpoint.eventCount !== eventHashes.length || checkpoint.lastHash !== lastHash) {
    throw new PromotionLedgerUnavailableError();
  }
}

export function assertCheckpointPrefix(checkpoint: PromotionCheckpoint, eventHashes: readonly string[]): void {
  if (checkpoint.eventCount > eventHashes.length) throw new PromotionLedgerUnavailableError();
  const checkpointTail = checkpoint.eventCount === 0 ? PROMOTION_GENESIS : eventHashes[checkpoint.eventCount - 1];
  if (checkpointTail !== checkpoint.lastHash) throw new PromotionLedgerUnavailableError();
}

export function writePromotionCheckpoint(path: string, secret: string, eventCount: number, lastHash: string): void {
  writeFileAtomicSync(path, JSON.stringify({
    version: 1,
    eventCount,
    lastHash,
    hmac: checkpointHmac(secret, eventCount, lastHash),
  }));
}
