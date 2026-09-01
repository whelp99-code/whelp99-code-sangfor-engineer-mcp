import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import {
  canonicalizeApprovalPayload,
  FileSingleUseNonceStore,
  signDomainApproval,
  verifyDomainApprovalSignature,
  type NonceConsumeResult,
} from '@sangfor/approval';
import { resolveProductionLocalWriteAuthority, resolveRepoData } from '@sangfor/shared';
import { isEvidenceFileConfined } from '@sangfor/version';

export const LEARNING_APPROVAL_DOMAIN = 'learning-strategy-v1';
export const LEARNING_APPROVAL_SECRET_ENV = 'SANGFOR_LEARNING_APPROVAL_SECRET';
export const LEARNING_NONCE_STORE_ENV = 'SANGFOR_LEARNING_NONCE_STORE_PATH';

const LEARNING_PAYLOAD_KEYS = [
  'entityType', 'entityId', 'revisionId', 'contentHash', 'fromState', 'toState',
  'evidenceFile', 'evidenceDigest', 'nonce', 'expiresAt',
] as const;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export interface LearningApprovalPayload {
  entityType: string;
  entityId: string;
  revisionId: string;
  contentHash: string;
  fromState: string;
  toState: string;
  evidenceFile: string;
  evidenceDigest: string;
  nonce: string;
  expiresAt: string;
}

export interface LearningApprovalEvent {
  type: 'learning.lifecycle.approval';
  domain: typeof LEARNING_APPROVAL_DOMAIN;
  occurredAt: string;
  payload: LearningApprovalPayload;
}

export type LearningApprovalErrorCode =
  | 'SECRET_NOT_CONFIGURED'
  | 'INVALID_SECRET_ENCODING'
  | 'INVALID_PAYLOAD'
  | 'APPROVAL_EXPIRED'
  | 'INVALID_SIGNATURE_ENCODING'
  | 'SIGNATURE_MISMATCH'
  | 'NONCE_REPLAY'
  | 'NONCE_STORE_UNAVAILABLE'
  | 'EVENT_APPEND_FAILED';

export class LearningApprovalError extends Error {
  readonly code: LearningApprovalErrorCode;

  constructor(code: LearningApprovalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'LearningApprovalError';
    this.code = code;
  }
}

function fail(code: LearningApprovalErrorCode, message: string): never {
  throw new LearningApprovalError(code, message);
}

function readOwnString(record: object, key: string): string {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(record, key); } catch { fail('INVALID_PAYLOAD', `${key} is not safely readable.`); }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'string') {
    fail('INVALID_PAYLOAD', `${key} must be an own string field.`);
  }
  return descriptor.value;
}

function normalizePayload(input: unknown): LearningApprovalPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PAYLOAD', 'payload must be an object.');
  const record = input as object;
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(record); } catch { fail('INVALID_PAYLOAD', 'payload prototype is not inspectable.'); }
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_PAYLOAD', 'payload must be a plain object.');
  let keys: (string | symbol)[];
  try { keys = Reflect.ownKeys(record); } catch { fail('INVALID_PAYLOAD', 'payload keys are not inspectable.'); }
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== LEARNING_PAYLOAD_KEYS.length
    || LEARNING_PAYLOAD_KEYS.some((key) => !keys.includes(key))) {
    fail('INVALID_PAYLOAD', 'payload contains unknown or missing fields.');
  }
  const values = Object.fromEntries(LEARNING_PAYLOAD_KEYS.map((key) => [key, readOwnString(record, key)])) as unknown as LearningApprovalPayload;
  for (const [key, value] of Object.entries(values)) {
    if (value.length === 0 || /[\r\n]/u.test(value)) fail('INVALID_PAYLOAD', `${key} must be non-empty and single-line.`);
  }
  if (!HASH.test(values.contentHash) || !HASH.test(values.evidenceDigest)) fail('INVALID_PAYLOAD', 'content and evidence hashes must be lowercase SHA-256 hex.');
  if (!validEvidenceReference(values.evidenceFile)) fail('INVALID_PAYLOAD', 'evidenceFile must be a relative path without traversal.');
  if (!Number.isFinite(Date.parse(values.expiresAt))) fail('INVALID_PAYLOAD', 'expiresAt must be a valid timestamp.');
  return Object.freeze({ ...values });
}

function validEvidenceReference(value: string): boolean {
  return value === value.trim() && !value.includes('\0') && !isAbsolute(value) && !win32.isAbsolute(value)
    && !/^[A-Za-z]:/u.test(value) && value.split(/[\\/]+/u).every((segment) => segment.length > 0 && segment !== '..');
}

function payloadFields(payload: LearningApprovalPayload): string[] {
  return [
    LEARNING_APPROVAL_DOMAIN, payload.entityType, payload.entityId, payload.revisionId,
    payload.contentHash, payload.fromState, payload.toState, payload.evidenceFile,
    payload.evidenceDigest, payload.nonce, payload.expiresAt,
  ];
}

export function canonicalizeLearningApprovalPayload(input: unknown): string {
  return canonicalizeApprovalPayload(payloadFields(normalizePayload(input)));
}

export function decodeLearningApprovalSecret(secret: string | undefined): Uint8Array {
  if (secret === undefined || secret === '') fail('SECRET_NOT_CONFIGURED', `${LEARNING_APPROVAL_SECRET_ENV} is not configured.`);
  if (typeof secret !== 'string') fail('INVALID_SECRET_ENCODING', 'learning approval secret must be a string.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(secret) || secret.length % 4 !== 0) fail('INVALID_SECRET_ENCODING', 'learning approval secret is not strict base64.');
  const bytes = Buffer.from(secret, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== secret) fail('INVALID_SECRET_ENCODING', 'learning approval secret must decode to exactly 32 bytes.');
  return new Uint8Array(bytes);
}

function learningSecret(secret?: string): Uint8Array {
  return decodeLearningApprovalSecret(secret ?? process.env[LEARNING_APPROVAL_SECRET_ENV]);
}

export function defaultLearningNonceStorePath(): string {
  return process.env[LEARNING_NONCE_STORE_ENV]
    ?? join(resolveRepoData('data/runtime'), 'learning-approval-nonces.json');
}

export function signLearningApproval(input: unknown, secret?: string): string {
  const payload = normalizePayload(input);
  return Buffer.from(signDomainApproval(learningSecret(secret), canonicalizeApprovalPayload(payloadFields(payload)))).toString('hex');
}

export interface VerifyLearningApprovalInput {
  payload: unknown;
  approvalToken: unknown;
  now?: Date;
  secret?: string;
}

export function verifyLearningApprovalSignature(input: VerifyLearningApprovalInput): LearningApprovalPayload {
  const payload = normalizePayload(input.payload);
  return verifyNormalizedLearningApproval(payload, input.approvalToken, input.now, input.secret);
}

function verifyNormalizedLearningApproval(
  payload: LearningApprovalPayload,
  approvalToken: unknown,
  nowInput?: Date,
  secret?: string,
): LearningApprovalPayload {
  const key = learningSecret(secret);
  if (typeof approvalToken !== 'string' || !TOKEN.test(approvalToken)) {
    fail('INVALID_SIGNATURE_ENCODING', 'learning approval signature must be lowercase 64-hex.');
  }
  const now = nowInput ?? new Date();
  const expiry = Date.parse(payload.expiresAt);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() > expiry) fail('APPROVAL_EXPIRED', 'learning approval has expired.');
  const verdict = verifyDomainApprovalSignature(
    key,
    canonicalizeApprovalPayload(payloadFields(payload)),
    Buffer.from(approvalToken, 'hex'),
  );
  if (!verdict.ok) fail('SIGNATURE_MISMATCH', 'learning approval signature does not match.');
  return payload;
}

export const verifyLearningApproval = verifyLearningApprovalSignature;

export interface PromoteLearningApprovalInput extends VerifyLearningApprovalInput {
  currentState: unknown;
  currentContentHash?: unknown;
  content?: string | Uint8Array;
  evidenceRoot: unknown;
  appendEvent: (event: LearningApprovalEvent) => void | Promise<void>;
  nonceStore?: Pick<FileSingleUseNonceStore, 'consume'>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceDigest(root: string, evidenceFile: string): string {
  if (!isEvidenceFileConfined(evidenceFile, { evidenceRoot: root })) fail('INVALID_PAYLOAD', 'evidenceFile is not a confined regular file.');
  try {
    const realRoot = realpathSync(resolve(root));
    const target = resolve(realRoot, evidenceFile);
    if (!lstatSync(target).isFile()) fail('INVALID_PAYLOAD', 'evidenceFile is not a regular file.');
    return sha256(readFileSync(target));
  } catch (error) {
    if (error instanceof LearningApprovalError) throw error;
    fail('INVALID_PAYLOAD', `evidenceFile could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function promoteLearningApproval(input: PromoteLearningApprovalInput): Promise<LearningApprovalEvent> {
  const payload = normalizePayload(input.payload);
  if (typeof input.currentState !== 'string' || payload.fromState !== input.currentState) fail('INVALID_PAYLOAD', 'fromState does not match the current lifecycle state.');
  if (typeof input.evidenceRoot !== 'string' || input.evidenceRoot.length === 0) fail('INVALID_PAYLOAD', 'evidenceRoot is required.');
  if (typeof input.appendEvent !== 'function') fail('INVALID_PAYLOAD', 'appendEvent is required.');
  const observedContentHash = input.content !== undefined
    ? (typeof input.content === 'string' || input.content instanceof Uint8Array ? sha256(input.content) : undefined)
    : input.currentContentHash;
  if (typeof observedContentHash !== 'string' || observedContentHash !== payload.contentHash) fail('INVALID_PAYLOAD', 'content hash does not match the approval payload.');
  if (evidenceDigest(input.evidenceRoot, payload.evidenceFile) !== payload.evidenceDigest) fail('INVALID_PAYLOAD', 'evidence digest does not match the approval payload.');
  const verifiedPayload = verifyNormalizedLearningApproval(payload, input.approvalToken, input.now, input.secret);
  const now = input.now ?? new Date();
  const noncePath = defaultLearningNonceStorePath();
  const store = input.nonceStore ?? new FileSingleUseNonceStore(noncePath, resolveProductionLocalWriteAuthority({
    tenantId: 'local-primary', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'local-primary',
    aggregate: 'approvals_nonces', sourceRoot: dirname(noncePath),
  }));
  const consumed: NonceConsumeResult = await store.consume(verifiedPayload.nonce, verifiedPayload.expiresAt, now);
  if (!consumed.ok) {
    if (consumed.reason?.startsWith('approval nonce already used:')) fail('NONCE_REPLAY', consumed.reason);
    fail('NONCE_STORE_UNAVAILABLE', consumed.reason ?? 'learning nonce store unavailable.');
  }
  const event: LearningApprovalEvent = {
    type: 'learning.lifecycle.approval',
    domain: LEARNING_APPROVAL_DOMAIN,
    occurredAt: now.toISOString(),
    payload: verifiedPayload,
  };
  try { await input.appendEvent(event); } catch (error) {
    fail('EVENT_APPEND_FAILED', error instanceof Error ? error.message : String(error));
  }
  return event;
}
