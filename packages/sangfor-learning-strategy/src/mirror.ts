import { createHash } from 'node:crypto';
import type { StrategyRevision, StrategyStore, StrategyStoreManager } from './store.js';

export type LearningMirrorEventType =
  | 'strategy_revision'
  | 'lifecycle_event'
  | 'method_catalog'
  | 'firmware_profile'
  | 'evidence'
  | 'run';

export interface LearningMirrorMetadata {
  strategyId?: string;
  revisionId?: string;
  state?: string;
  contentDigest?: string;
  evidenceDigest?: string;
  methodCodes?: string[];
  deviceScopeDigest?: string;
  coverage?: Record<string, number>;
  latencyMs?: number;
  status?: string;
  methodCode?: string;
  vendor?: string;
  productCode?: string;
  productVariant?: string;
  versionRaw?: string;
  specVersion?: string;
  registryDigest?: string;
  uiFingerprint?: string;
  apiFingerprint?: string;
  fromState?: string;
  toState?: string;
  evidenceKind?: string;
  completedAt?: string;
}

export interface LearningMirrorOutboxEvent {
  eventId: string;
  eventType: LearningMirrorEventType;
  occurredAt: string;
  payloadDigest: string;
  metadata: LearningMirrorMetadata;
  status: 'pending' | 'mirrored' | 'dlq';
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
}

export interface LearningMirrorReceiptRecord {
  eventId: string;
  payloadDigest: string;
  mirroredAt: string;
  status: 'mirrored';
}

export interface LearningMirrorAdapter {
  upsert(event: LearningMirrorOutboxEvent): Promise<{ mirroredAt?: string }>;
}

export interface LearningMirrorSyncResult {
  attempted: number;
  mirrored: number;
  failed: number;
  dlq: number;
  pending: number;
  committed: boolean;
  errors: Array<{ eventId: string; code: string }>;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_MIRROR_KEY = /(?:path|payload|password|secret|token|authorization|cookie|credential)/iu;
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function assertSafeMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value as object)) throw new Error('INVALID_MIRROR_EVENT: cyclic metadata.');
  seen.add(value as object);
  if (Array.isArray(value)) value.forEach((item, index) => assertSafeMetadata(item, `${path}[${index}]`, seen));
  else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_MIRROR_KEY.test(key)) throw new Error(`INVALID_MIRROR_EVENT: forbidden metadata key ${path}.${key}.`);
      assertSafeMetadata(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value as object);
}

function canonicalTimestamp(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`INVALID_MIRROR_EVENT: ${field} is invalid.`);
  return value;
}

export function validateMirrorEvent(input: unknown): LearningMirrorOutboxEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_MIRROR_EVENT: event must be an object.');
  const event = input as LearningMirrorOutboxEvent;
  if (typeof event.eventId !== 'string' || event.eventId.length === 0
    || !['strategy_revision', 'lifecycle_event', 'method_catalog', 'firmware_profile', 'evidence', 'run'].includes(event.eventType)
    || !SHA256.test(event.payloadDigest)
    || !['pending', 'mirrored', 'dlq'].includes(event.status)
    || !Number.isSafeInteger(event.attempts) || event.attempts < 0 || event.attempts > MAX_ATTEMPTS
    || !event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
    throw new Error('INVALID_MIRROR_EVENT: event fields are invalid.');
  }
  canonicalTimestamp(event.occurredAt, 'occurredAt');
  canonicalTimestamp(event.nextAttemptAt, 'nextAttemptAt');
  assertSafeMetadata(event.metadata);
  if (event.metadata.contentDigest !== undefined && !SHA256.test(event.metadata.contentDigest)) {
    throw new Error('INVALID_MIRROR_EVENT: content digest is invalid.');
  }
  if (event.metadata.evidenceDigest !== undefined && !SHA256.test(event.metadata.evidenceDigest)) {
    throw new Error('INVALID_MIRROR_EVENT: evidence digest is invalid.');
  }
  if (event.metadata.deviceScopeDigest !== undefined && !SHA256.test(event.metadata.deviceScopeDigest)) {
    throw new Error('INVALID_MIRROR_EVENT: device scope digest is invalid.');
  }
  return structuredClone(event);
}

export function createRevisionMirrorEvent(revision: StrategyRevision): LearningMirrorOutboxEvent {
  const metadata: LearningMirrorMetadata = {
    strategyId: revision.strategyId,
    revisionId: revision.revisionId,
    state: revision.state,
    contentDigest: revision.contentHash,
    ...(revision.evidenceDigest === undefined ? {} : { evidenceDigest: revision.evidenceDigest }),
    ...(revision.methods === undefined ? {} : { methodCodes: [...revision.methods] }),
    status: revision.state,
  };
  assertSafeMetadata(metadata);
  const occurredAt = canonicalTimestamp(revision.createdAt, 'revision.createdAt');
  const eventId = `strategy-revision:${revision.revisionId}`;
  return validateMirrorEvent({
    eventId,
    eventType: 'strategy_revision',
    occurredAt,
    payloadDigest: sha256(canonicalJson({ eventId, eventType: 'strategy_revision', occurredAt, metadata })),
    metadata,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: occurredAt,
  });
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[^A-Za-z0-9_:-]/gu, '_').slice(0, 120) || 'MIRROR_UPSERT_FAILED';
}

export async function syncStrategyMirror(
  manager: StrategyStoreManager,
  adapter: LearningMirrorAdapter,
  now: Date = new Date(),
): Promise<LearningMirrorSyncResult> {
  if (!Number.isFinite(now.getTime())) throw new Error('MIRROR_CLOCK_INVALID: now is invalid.');
  const store = manager.load();
  if (!store) throw new Error('MIRROR_STORE_UNAVAILABLE: local canonical store is missing or corrupt.');
  const currentGeneration = store.currentGeneration;
  const updated: StrategyStore = structuredClone(store);
  const receipts = new Map(updated.mirrorReceipts.map((receipt) => [receipt.eventId, receipt]));
  let attempted = 0;
  let mirrored = 0;
  let failed = 0;
  let dlq = 0;
  let changed = false;
  const errors: Array<{ eventId: string; code: string }> = [];
  for (const event of updated.mirrorOutbox) {
    validateMirrorEvent(event);
    if (event.status !== 'pending' || Date.parse(event.nextAttemptAt) > now.getTime()) continue;
    if (receipts.has(event.eventId)) {
      event.status = 'mirrored';
      changed = true;
      mirrored += 1;
      continue;
    }
    attempted += 1;
    try {
      const receipt = await adapter.upsert(structuredClone(event));
      const mirroredAt = receipt.mirroredAt ?? now.toISOString();
      canonicalTimestamp(mirroredAt, 'mirroredAt');
      const record: LearningMirrorReceiptRecord = { eventId: event.eventId, payloadDigest: event.payloadDigest, mirroredAt, status: 'mirrored' };
      updated.mirrorReceipts.push(record);
      receipts.set(record.eventId, record);
      event.status = 'mirrored';
      delete event.lastErrorCode;
      mirrored += 1;
      changed = true;
    } catch (error) {
      event.attempts += 1;
      event.lastErrorCode = errorCode(error);
      if (event.attempts >= MAX_ATTEMPTS) {
        event.status = 'dlq';
        dlq += 1;
      } else {
        const delay = Math.min(1_000 * (2 ** (event.attempts - 1)), MAX_BACKOFF_MS);
        event.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
        failed += 1;
      }
      errors.push({ eventId: event.eventId, code: event.lastErrorCode });
      changed = true;
    }
  }
  let committed = false;
  if (changed) {
    const result = await manager.commit(updated, currentGeneration);
    if (!result.ok) throw new Error(`MIRROR_STORE_COMMIT_FAILED: ${result.error ?? 'unknown error'}`);
    committed = true;
  }
  return {
    attempted,
    mirrored,
    failed,
    dlq,
    pending: updated.mirrorOutbox.filter((event) => event.status === 'pending').length,
    committed,
    errors,
  };
}
