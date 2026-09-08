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
import { ApprovalDecision, ConsoleAction, RiskLevel, expectedLocalWriteScope, requireLocalWriteAuthority, type LocalWriteAuthority } from '@sangfor/shared';

export {
  PostgresSingleUseNonceStore,
  type PostgresNonceStoreOptions,
} from './postgres-nonce-store.js';

const APPROVAL_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_LEGACY_APPROVAL_FIELDS = 32;
const MAX_LEGACY_APPROVAL_FIELD_LENGTH = 1_000_000;

export function hasApprovalControlCharacters(value: string): boolean {
  return APPROVAL_CONTROL_CHARACTER.test(value);
}

function approvalFieldsAreSafe(fields: readonly string[]): boolean {
  return fields.length > 0
    && fields.length <= MAX_LEGACY_APPROVAL_FIELDS
    && fields.every((field) => field.length <= MAX_LEGACY_APPROVAL_FIELD_LENGTH
      && !hasApprovalControlCharacters(field));
}

export function canonicalizeApprovalPayload(fields: readonly string[]): string {
  if (!approvalFieldsAreSafe(fields)) throw new Error('approval field contains a control character or exceeds bounds');
  return `approval-v2:${JSON.stringify(fields)}`;
}

export function verifyLegacyDomainApprovalSignature(
  secret: string | Uint8Array,
  fields: readonly string[],
  signatureBytes: Uint8Array,
): { ok: boolean; reason?: string } {
  if (!approvalFieldsAreSafe(fields)) return { ok: false, reason: 'legacy approval fields invalid' };
  return verifyDomainApprovalSignature(secret, fields.join('\n'), signatureBytes);
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
  if (timingSafeEqual(Buffer.from(expected), Buffer.from(signatureBytes))) return { ok: true };
  if (!canonicalPayload.startsWith('approval-v2:')) return { ok: false, reason: 'signature mismatch' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonicalPayload.slice('approval-v2:'.length));
  } catch {
    return { ok: false, reason: 'signature mismatch' };
  }
  if (!Array.isArray(decoded) || !decoded.every((field) => typeof field === 'string')) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return verifyLegacyDomainApprovalSignature(secret, decoded, signatureBytes);
}

export interface NonceConsumeResult { ok: boolean; reason?: string; }

interface NonceRecord { nonce: string; expiresAt: string; consumedAt: string; authorityEpoch: number; }
interface NonceStoreShape { consumed: NonceRecord[]; migrated: boolean; }

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

function readNonceStore(filePath: string, legacyAuthorityEpoch: number): NonceStoreShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { consumed: [], migrated: false };
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'consumed')
    || !Array.isArray((parsed as { consumed?: unknown }).consumed)) {
    throw new Error('nonce store shape invalid');
  }
  let migrated = false;
  const consumed = (parsed as { consumed: unknown[] }).consumed.map((record) => {
    const value = record as Partial<NonceRecord>;
    const keys = record && typeof record === 'object' && !Array.isArray(record)
      ? Object.keys(record).sort().join(',')
      : '';
    const legacy = keys === 'consumedAt,expiresAt,nonce';
    migrated ||= legacy;
    if ((!legacy && keys !== 'authorityEpoch,consumedAt,expiresAt,nonce')
      || typeof value.nonce !== 'string' || value.nonce.length === 0
      || hasApprovalControlCharacters(value.nonce)
      || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || typeof value.consumedAt !== 'string' || !Number.isFinite(Date.parse(value.consumedAt))
      || (!legacy && (!Number.isInteger(value.authorityEpoch) || Number(value.authorityEpoch) < 0))) {
      throw new Error('nonce store record invalid');
    }
    return {
      nonce: value.nonce,
      expiresAt: value.expiresAt,
      consumedAt: value.consumedAt,
      authorityEpoch: legacy ? legacyAuthorityEpoch : Number(value.authorityEpoch),
    };
  });
  const identities = new Set(consumed.map((record) => `${record.authorityEpoch}\u0000${record.nonce}`));
  if (identities.size !== consumed.length) throw new Error('nonce store records ambiguous');
  return { consumed, migrated };
}

function syncParentDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class FileSingleUseNonceStore {
  private readonly authority: LocalWriteAuthority;

  constructor(private readonly filePath: string, authority: LocalWriteAuthority) {
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'approvals_nonces', dirname(this.filePath),
    ));
  }

  inspect(nonce: string, expiresAt: string, now: Date = new Date()): NonceConsumeResult {
    if (typeof nonce !== 'string' || nonce.length === 0 || hasApprovalControlCharacters(nonce)
      || !Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(now.getTime())) {
      return { ok: false, reason: 'invalid nonce input' };
    }
    if (Date.parse(expiresAt) < now.getTime()) {
      return { ok: false, reason: `approval nonce expired: ${nonce}` };
    }
    try {
      const state = readNonceStore(this.filePath, this.authority.epoch);
      const replayed = state.consumed.some((record) => (
        record.nonce === nonce && record.authorityEpoch === this.authority.epoch
      ));
      return replayed
        ? { ok: false, reason: `approval nonce already used: ${nonce}` }
        : { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async consume(nonce: string, expiresAt: string, now: Date = new Date()): Promise<NonceConsumeResult> {
    return this.authority.fence.write(this.authority, { operation: 'approval-nonce.consume', targetPaths: [this.filePath] }, () => {
    if (typeof nonce !== 'string' || nonce.length === 0 || hasApprovalControlCharacters(nonce)
      || !Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(now.getTime())) {
      return { ok: false, reason: 'invalid nonce input' };
    }
    const lockPath = `${this.filePath}.lock`;
    let lockAcquired = false;
    let tempPath: string | undefined;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      acquireNonceLock(lockPath);
      lockAcquired = true;
      const state = readNonceStore(this.filePath, this.authority.epoch);
      const live = state.consumed.filter((record) => Date.parse(record.expiresAt) >= now.getTime());
      const replayed = live.some((record) => record.nonce === nonce && record.authorityEpoch === this.authority.epoch);
      if (!replayed) {
        live.push({ nonce, expiresAt, consumedAt: now.toISOString(), authorityEpoch: this.authority.epoch });
      }
      if (state.migrated || !replayed) {
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
      }
      return replayed
        ? { ok: false, reason: `approval nonce already used: ${nonce}` }
        : { ok: true };
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
    });
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
