import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilePromotionLedger,
  PromotionLedgerIndeterminateError,
  PromotionLedgerUnavailableError,
  capabilityTargetSchema,
  maskedPromotionRef,
  type PromotionLedgerEventInput,
} from '../packages/sangfor-competency/src/index.js';

const SECRET = 'promotion-ledger-dedicated-secret-32-bytes';
const CHECKPOINT_SECRET = 'promotion-checkpoint-dedicated-secret-32';
const target = capabilityTargetSchema.parse({
  productId: 'HCI_SCP', capabilityId: 'resource_inventory',
  toolId: 'sangfor_evaluate_config', workAtomIds: ['op_daily_health'],
});

function event(index: number): PromotionLedgerEventInput {
  return {
    version: 1,
    eventId: `event-${index}`,
    at: `2026-08-25T12:${String(index).padStart(2, '0')}:00.000Z`,
    outcome: 'rejected',
    action: 'reject',
    target,
    fromMaturity: 'tested_mock',
    toMaturity: 'tested_mock',
    decisionRef: maskedPromotionRef('decision', `secret-input-${index}`),
    manifestRef: maskedPromotionRef('manifest', 'manifest-digest'),
    nonceRef: maskedPromotionRef('nonce', `nonce-${index}`),
    refusalCode: 'signature_mismatch',
  };
}

describe('file capability promotion decision ledger', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promotion-ledger-'));
    path = join(root, 'decisions.jsonl');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('fails closed for a missing ledger, checkpoint, or dedicated secret', () => {
    expect(() => FilePromotionLedger.open(path, SECRET, CHECKPOINT_SECRET)).toThrow(PromotionLedgerUnavailableError);
    FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET);
    expect(() => FilePromotionLedger.open(path, undefined, CHECKPOINT_SECRET)).toThrow(PromotionLedgerUnavailableError);
    expect(() => FilePromotionLedger.open(path, SECRET, undefined)).toThrow(PromotionLedgerUnavailableError);
  });

  it('detects malformed, truncated, and hash-modified lines', () => {
    const ledger = FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET);
    ledger.append(event(1));
    const valid = readFileSync(path, 'utf8');
    for (const corrupt of ['not-json\n', valid.slice(0, -12), valid.replace('signature_mismatch', 'forged')]) {
      writeFileSync(path, corrupt);
      expect(ledger.verify().ok).toBe(false);
    }
  });

  it('serializes 32 appenders into one contiguous masked chain', async () => {
    const ledger = FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET);
    await Promise.all(Array.from({ length: 32 }, (_, index) => Promise.resolve().then(() => ledger.append(event(index)))));
    const events = ledger.read();
    expect(events.map(({ seq }) => seq)).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(ledger.verify()).toEqual({ ok: true });
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain('secret-input');
    expect(persisted).not.toContain('nonce-');
  });

  it('refuses deleted, stale, ahead, behind, mismatched, and corrupt checkpoints', () => {
    const ledger = FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET);
    const checkpointPath = `${path}.head.json`;
    const emptyHead = readFileSync(checkpointPath, 'utf8');
    ledger.append(event(1));
    const validLedger = readFileSync(path, 'utf8');
    const validHead = readFileSync(checkpointPath, 'utf8');
    const corruptions = [
      () => unlinkSync(checkpointPath),
      () => writeFileSync(checkpointPath, emptyHead),
      () => writeFileSync(path, ''),
      () => appendFileSync(path, validLedger),
      () => writeFileSync(checkpointPath, validHead.replace('"eventCount":1', '"eventCount":2')),
      () => writeFileSync(checkpointPath, '{'),
    ];
    for (const corrupt of corruptions) {
      writeFileSync(path, validLedger);
      writeFileSync(checkpointPath, validHead);
      corrupt();
      expect(() => ledger.read()).toThrow(PromotionLedgerUnavailableError);
    }
  });

  it.each(['afterEventDurable', 'afterCheckpointDurable'] as const)(
    'returns an indeterminate append at %s and requires verified restart reconciliation',
    (faultPoint) => {
      const ledger = FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET, {
        [faultPoint]: () => { throw new Error('simulated acknowledgement loss'); },
      });
      expect(() => ledger.append(event(1))).toThrow(PromotionLedgerIndeterminateError);
      const restarted = FilePromotionLedger.open(path, SECRET, CHECKPOINT_SECRET);
      if (faultPoint === 'afterEventDurable') {
        expect(() => restarted.read()).toThrow(PromotionLedgerUnavailableError);
      } else {
        expect(restarted.read()).toHaveLength(1);
      }
      expect(restarted.reconcile()).toHaveLength(1);
      expect(restarted.read()).toHaveLength(1);
    },
  );

  it('refuses a nonempty legacy ledger with no checkpoint instead of rebuilding it', () => {
    writeFileSync(path, '{}\n');
    expect(() => FilePromotionLedger.initialize(path, SECRET, CHECKPOINT_SECRET)).toThrow(PromotionLedgerUnavailableError);
  });
});
