import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ApprovalDecision, ConsoleAction, RiskLevel } from '@sangfor/shared';

export {
  PostgresSingleUseNonceStore,
  type PostgresNonceStoreOptions,
} from './postgres-nonce-store.js';

export function canonicalizeApprovalPayload(fields: readonly string[]): string {
  return fields.join('\n');
}

export function signDomainApproval(secret: string | Uint8Array, canonicalPayload: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', secret).update(canonicalPayload, 'utf8').digest());
}

export function verifyDomainApprovalSignature(
  secret: string | Uint8Array,
  canonicalPayload: string,
  signatureBytes: Uint8Array,
): { ok: boolean; reason?: string } {
  if (!(signatureBytes instanceof Uint8Array)) return { ok: false, reason: 'signature bytes invalid' };
  const expected = signDomainApproval(secret, canonicalPayload);
  if (signatureBytes.byteLength !== expected.byteLength) return { ok: false, reason: 'signature length mismatch' };
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureBytes))
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

export interface NonceConsumeResult { ok: boolean; reason?: string; }

interface NonceRecord { nonce: string; expiresAt: string; consumedAt: string; }
interface NonceStoreShape { consumed: NonceRecord[]; }

const NONCE_LOCK_WAIT_MS = 2_000;

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireNonceLock(lockPath: string): void {
  const deadline = monotonicNowMs() + NONCE_LOCK_WAIT_MS;
  while (true) {
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      chmodSync(lockPath, 0o700);
      return;
    } catch (error) {
      if (created) {
        try { rmdirSync(lockPath); } catch { /* retain fail-closed behavior if cleanup fails */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const remaining = deadline - monotonicNowMs();
      if (remaining <= 0) throw new Error('NONCE_STORE_LOCK_TIMEOUT');
      pause(Math.min(25, remaining));
    }
  }
}

function readNonceStore(filePath: string): NonceStoreShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { consumed: [] };
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'consumed')
    || !Array.isArray((parsed as { consumed?: unknown }).consumed)) {
    throw new Error('nonce store shape invalid');
  }
  const consumed = (parsed as { consumed: unknown[] }).consumed.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== 3
      || typeof (record as Partial<NonceRecord>).nonce !== 'string'
      || typeof (record as Partial<NonceRecord>).expiresAt !== 'string'
      || typeof (record as Partial<NonceRecord>).consumedAt !== 'string'
      || (record as Partial<NonceRecord>).nonce!.length === 0
      || !Number.isFinite(Date.parse((record as Partial<NonceRecord>).expiresAt!))
      || !Number.isFinite(Date.parse((record as Partial<NonceRecord>).consumedAt!))) {
      throw new Error('nonce store record invalid');
    }
    return record as NonceRecord;
  });
  return { consumed };
}

function syncParentDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class FileSingleUseNonceStore {
  constructor(private readonly filePath: string) {}

  consume(nonce: string, expiresAt: string, now: Date = new Date()): NonceConsumeResult {
    if (typeof nonce !== 'string' || nonce.length === 0 || !Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(now.getTime())) {
      return { ok: false, reason: 'invalid nonce input' };
    }
    const lockPath = `${this.filePath}.lock`;
    let lockAcquired = false;
    let tempPath: string | undefined;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      acquireNonceLock(lockPath);
      lockAcquired = true;
      const state = readNonceStore(this.filePath);
      const live = state.consumed.filter((record) => Date.parse(record.expiresAt) >= now.getTime());
      if (live.some((record) => record.nonce === nonce)) {
        return { ok: false, reason: `approval nonce already used: ${nonce}` };
      }
      live.push({ nonce, expiresAt, consumedAt: now.toISOString() });
      tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const fd = openSync(tempPath, 'wx', 0o600);
      try {
        const content = JSON.stringify({ consumed: live }, null, 2);
        writeFileDescriptor(fd, content);
        fsyncSync(fd);
        chmodSync(tempPath, 0o600);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, this.filePath);
      tempPath = undefined;
      syncParentDirectory(dirname(this.filePath));
      return { ok: true };
    } catch (error) {
      // Return the raw storage detail. Domain adapters map it to their public
      // contract: the operator wrapper re-wraps it as
      // `nonce store unavailable (fail-closed): ...` (byte-for-byte with the
      // legacy store) and the learning adapter raises a typed
      // `NONCE_STORE_UNAVAILABLE` code. Replay keeps its public prefix below.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch { /* exact temp cleanup is best effort */ }
      }
      if (lockAcquired) {
        try { rmdirSync(lockPath); } catch { /* leave a failed lock fail-closed */ }
      }
    }
  }
}

function writeFileDescriptor(fd: number, content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
}

const DANGEROUS_TERMS = [
  'apply', 'save', 'delete', 'remove', 'reboot', 'restart', 'shutdown',
  'failover', 'migration start', 'cutover', 'enable policy', 'activate license',
  'password', 'otp', 'mfa', 'production', 'format', 'drop', 'factory reset',
  'agent deployment', 'endpoint isolation', 'isolate endpoint', 'soar response',
  'response action', 'route change', 'nat change', 'interface change',
  'vm power', 'power off', 'power on', 'vm migrate', 'vm delete',
  'security policy', 'policy change'
];

export function classifyTextRisk(text: string): RiskLevel {
  const value = text.toLowerCase();
  if (['delete', 'shutdown', 'factory reset', 'drop', 'format', 'endpoint isolation', 'isolate endpoint', 'soar response', 'response action', 'vm delete'].some(term => value.includes(term))) return 'critical';
  if (DANGEROUS_TERMS.some(term => value.includes(term))) return 'high';
  if (['network', 'policy', 'storage', 'migration', 'route', 'nat', 'interface'].some(term => value.includes(term))) return 'medium';
  return 'low';
}

export function requiresApprovalForText(text: string): ApprovalDecision {
  const riskLevel = classifyTextRisk(text);
  return {
    required: riskLevel === 'high' || riskLevel === 'critical',
    riskLevel,
    reason: riskLevel === 'high' || riskLevel === 'critical'
      ? 'This operation may change production configuration or cause service impact.'
      : 'No approval required for read-only or planning operation.'
  };
}

export function requiresApprovalForAction(action: ConsoleAction): ApprovalDecision {
  const joined = `${action.type} ${action.target ?? ''} ${action.value ?? ''}`;
  return requiresApprovalForText(joined);
}
