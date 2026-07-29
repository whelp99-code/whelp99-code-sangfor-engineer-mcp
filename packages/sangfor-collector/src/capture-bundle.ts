import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CAPTURE_BUNDLE_VERSION = 'capture-bundle.v1' as const;
export const CAPTURE_BUNDLE_MAX_BYTES = 100 * 1024 * 1024;
export const CAPTURE_ITEM_MAX_BYTES = 2 * 1024 * 1024;
export const CAPTURE_EVENT_MAX_COUNT = 10_000;
export const CAPTURE_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const REDACTION_CANARY = 'capture-redaction-v1-clean';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const FORBIDDEN_KEY = /(?:^|[_-])(authorization|cookie|set[_-]?cookie|token|password|passwd|secret|api[_-]?key|credential)(?:$|[_-])/iu;
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u,
  /\b(?:\d[ -]*?){13,16}\b/u,
];

export interface CaptureBundleMetadata {
  version: typeof CAPTURE_BUNDLE_VERSION;
  keyId: string;
  captureId: string;
  deviceScopeDigest: string;
  capturedAt: string;
  expiresAt: string;
  product: string;
  firmwareVersion?: string;
  redactionCanary: string;
  aadDigest: string;
  ciphertextDigest: string;
}

export interface CaptureBundle {
  metadata: CaptureBundleMetadata;
  encryptedPayload: string;
  iv: string;
  authTag: string;
}

export interface CaptureBundleKeys {
  encryptionKey: Buffer;
  keyId?: string;
}

export interface CaptureKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}

export interface PromoteCaptureInput {
  payload: unknown;
  deviceScope: string;
  product: string;
  firmwareVersion?: string;
  capturesDir: string;
  stagingRoot: string;
  keyring: CaptureKeyring;
  captureId?: string;
  capturedAt?: Date;
  retentionMs?: number;
}

export interface CaptureBundleSummary {
  path: string;
  bundleDigest: string;
  ciphertextDigest: string;
  deviceScopeDigest: string;
  captureId: string;
  capturedAt: string;
  expiresAt: string;
  product: string;
  firmwareVersion?: string;
  keyId: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function parseIso(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`INVALID_CAPTURE_BUNDLE: ${field} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`INVALID_CAPTURE_BUNDLE: ${field} must be a canonical ISO timestamp.`);
  }
  return value;
}

function strictBase64(value: unknown, expectedBytes: number, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !STRICT_BASE64.test(value)) {
    throw new Error(`INVALID_CAPTURE_BUNDLE: ${field} must be strict base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    throw new Error(`INVALID_CAPTURE_BUNDLE: ${field} has an invalid decoded length.`);
  }
  return decoded;
}

function validateKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('INVALID_CAPTURE_KEY: AES-256-GCM key must be exactly 32 bytes.');
  }
  return key;
}

function metadataAad(metadata: Omit<CaptureBundleMetadata, 'aadDigest' | 'ciphertextDigest'>): string {
  return canonicalJson(metadata);
}

function validatePlainMetadata(
  metadata: Omit<CaptureBundleMetadata, 'redactionCanary' | 'aadDigest' | 'ciphertextDigest'>,
): void {
  if (metadata.version !== CAPTURE_BUNDLE_VERSION) throw new Error('INVALID_CAPTURE_BUNDLE: unsupported version.');
  if (!SAFE_ID.test(metadata.keyId)) throw new Error('INVALID_CAPTURE_BUNDLE: keyId is unsafe.');
  if (!SAFE_ID.test(metadata.captureId)) throw new Error('INVALID_CAPTURE_BUNDLE: captureId is unsafe.');
  if (!HEX_64.test(metadata.deviceScopeDigest)) throw new Error('INVALID_CAPTURE_BUNDLE: deviceScopeDigest is invalid.');
  if (!SAFE_ID.test(metadata.product)) throw new Error('INVALID_CAPTURE_BUNDLE: product is unsafe.');
  if (metadata.firmwareVersion !== undefined && !SAFE_ID.test(metadata.firmwareVersion)) {
    throw new Error('INVALID_CAPTURE_BUNDLE: firmwareVersion is unsafe.');
  }
  const capturedAt = Date.parse(parseIso(metadata.capturedAt, 'capturedAt'));
  const expiresAt = Date.parse(parseIso(metadata.expiresAt, 'expiresAt'));
  if (expiresAt <= capturedAt) throw new Error('INVALID_CAPTURE_BUNDLE: expiresAt must follow capturedAt.');
}

function assertPayloadLimits(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  const encoded = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (encoded > CAPTURE_ITEM_MAX_BYTES && path !== '$') {
    throw new Error(`CAPTURE_ITEM_TOO_LARGE: ${path} exceeds 2MiB.`);
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value as object)) throw new Error('INVALID_CAPTURE_PAYLOAD: cyclic value.');
  seen.add(value as object);
  if (Array.isArray(value)) {
    if (value.length > CAPTURE_EVENT_MAX_COUNT) throw new Error('CAPTURE_EVENT_LIMIT: more than 10000 events.');
    value.forEach((item, index) => assertPayloadLimits(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`CAPTURE_REDACTION_FAILED: forbidden key at ${path}.${key}.`);
      assertPayloadLimits(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value as object);
}

export function computeDeviceScopeDigest(deviceScope: string): string {
  if (typeof deviceScope !== 'string' || !UUID_V7.test(deviceScope)) {
    throw new Error('INVALID_DEVICE_SCOPE: deviceScope must be a lowercase non-PII UUIDv7.');
  }
  return sha256(deviceScope);
}

export function generateCaptureBundleKeys(keyId = 'test-key'): CaptureBundleKeys {
  if (!SAFE_ID.test(keyId)) throw new Error('INVALID_CAPTURE_KEY: keyId is unsafe.');
  return { encryptionKey: randomBytes(32), keyId };
}

export function parseCaptureKeyring(keysJson: string | undefined, activeKeyId: string | undefined): CaptureKeyring {
  if (!keysJson || !activeKeyId || !SAFE_ID.test(activeKeyId)) {
    throw new Error('CAPTURE_KEYRING_UNAVAILABLE: keyring and active key id are required.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(keysJson); } catch { throw new Error('INVALID_CAPTURE_KEYRING: keyring must be JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_CAPTURE_KEYRING: keyring must be an object.');
  }
  const keys: Record<string, Buffer> = {};
  for (const [keyId, encoded] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SAFE_ID.test(keyId)) throw new Error('INVALID_CAPTURE_KEYRING: key id is unsafe.');
    keys[keyId] = strictBase64(encoded, 32, `keyring.${keyId}`);
  }
  if (!Object.prototype.hasOwnProperty.call(keys, activeKeyId)) {
    throw new Error('CAPTURE_KEYRING_UNAVAILABLE: active key is absent.');
  }
  return Object.freeze({ activeKeyId, keys: Object.freeze(keys) });
}

export function captureKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureKeyring {
  return parseCaptureKeyring(env.SANGFOR_CAPTURE_BUNDLE_KEYS, env.SANGFOR_CAPTURE_BUNDLE_ACTIVE_KEY_ID);
}

export const REDACTION_PATTERNS = [...SENSITIVE_VALUE_PATTERNS];

export function containsSensitiveData(payload: unknown): boolean {
  try {
    const visit = (value: unknown, seen: WeakSet<object>): boolean => {
      if (typeof value === 'string') return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
      if (!value || typeof value !== 'object') return false;
      if (seen.has(value as object)) return true;
      seen.add(value as object);
      if (Array.isArray(value)) return value.some((item) => visit(item, seen));
      return Object.entries(value as Record<string, unknown>)
        .some(([key, child]) => FORBIDDEN_KEY.test(key) || visit(child, seen));
    };
    return visit(payload, new WeakSet<object>());
  } catch {
    return true;
  }
}

export function encryptCaptureBundle(
  payload: unknown,
  keys: CaptureBundleKeys,
  metadata: Omit<CaptureBundleMetadata, 'redactionCanary' | 'aadDigest' | 'ciphertextDigest'>,
): CaptureBundle {
  validateKey(keys.encryptionKey);
  validatePlainMetadata(metadata);
  assertPayloadLimits(payload);
  if (containsSensitiveData(payload)) throw new Error('CAPTURE_REDACTION_FAILED: sensitive data detected.');
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length > CAPTURE_BUNDLE_MAX_BYTES) throw new Error('CAPTURE_BUNDLE_TOO_LARGE: plaintext exceeds 100MiB.');
  const iv = randomBytes(12);
  const aadBase = { ...metadata, redactionCanary: REDACTION_CANARY };
  const aad = metadataAad(aadBase);
  const cipher = createCipheriv('aes-256-gcm', keys.encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    metadata: {
      ...aadBase,
      aadDigest: sha256(aad),
      ciphertextDigest: sha256(encrypted),
    },
    encryptedPayload: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function validateCaptureBundle(input: unknown): CaptureBundle {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_CAPTURE_BUNDLE: envelope must be an object.');
  const envelope = input as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort();
  if (JSON.stringify(envelopeKeys) !== JSON.stringify(['authTag', 'encryptedPayload', 'iv', 'metadata'])) {
    throw new Error('INVALID_CAPTURE_BUNDLE: envelope contains missing or unknown keys.');
  }
  const metadataValue = envelope.metadata;
  if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
    throw new Error('INVALID_CAPTURE_BUNDLE: metadata must be an object.');
  }
  const metadata = metadataValue as Record<string, unknown>;
  const required = ['aadDigest', 'captureId', 'capturedAt', 'ciphertextDigest', 'deviceScopeDigest', 'expiresAt', 'keyId', 'product', 'redactionCanary', 'version'];
  const allowed = new Set([...required, 'firmwareVersion']);
  const keys = Object.keys(metadata);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(metadata, key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error('INVALID_CAPTURE_BUNDLE: metadata contains missing or unknown keys.');
  }
  const plain = {
    version: metadata.version,
    keyId: metadata.keyId,
    captureId: metadata.captureId,
    deviceScopeDigest: metadata.deviceScopeDigest,
    capturedAt: metadata.capturedAt,
    expiresAt: metadata.expiresAt,
    product: metadata.product,
    ...(metadata.firmwareVersion === undefined ? {} : { firmwareVersion: metadata.firmwareVersion }),
  } as Omit<CaptureBundleMetadata, 'redactionCanary' | 'aadDigest' | 'ciphertextDigest'>;
  validatePlainMetadata(plain);
  if (metadata.redactionCanary !== REDACTION_CANARY || typeof metadata.aadDigest !== 'string' || !HEX_64.test(metadata.aadDigest)
    || typeof metadata.ciphertextDigest !== 'string' || !HEX_64.test(metadata.ciphertextDigest)) {
    throw new Error('INVALID_CAPTURE_BUNDLE: integrity metadata is invalid.');
  }
  const encrypted = strictBase64(envelope.encryptedPayload, Buffer.from(String(envelope.encryptedPayload), 'base64').length, 'encryptedPayload');
  if (encrypted.length > CAPTURE_BUNDLE_MAX_BYTES || sha256(encrypted) !== metadata.ciphertextDigest) {
    throw new Error('INVALID_CAPTURE_BUNDLE: ciphertext digest or size is invalid.');
  }
  strictBase64(envelope.iv, 12, 'iv');
  strictBase64(envelope.authTag, 16, 'authTag');
  const typedMetadata = { ...plain, redactionCanary: REDACTION_CANARY, aadDigest: metadata.aadDigest, ciphertextDigest: metadata.ciphertextDigest };
  const aad = metadataAad({ ...plain, redactionCanary: REDACTION_CANARY });
  if (sha256(aad) !== typedMetadata.aadDigest) throw new Error('INVALID_CAPTURE_BUNDLE: AAD digest mismatch.');
  return { metadata: typedMetadata, encryptedPayload: envelope.encryptedPayload as string, iv: envelope.iv as string, authTag: envelope.authTag as string };
}

export function decryptCaptureBundle(bundleInput: CaptureBundle, keys: CaptureBundleKeys): unknown {
  const bundle = validateCaptureBundle(bundleInput);
  validateKey(keys.encryptionKey);
  if (keys.keyId !== undefined && keys.keyId !== bundle.metadata.keyId) throw new Error('CAPTURE_KEY_MISMATCH: key id differs.');
  const iv = strictBase64(bundle.iv, 12, 'iv');
  const authTag = strictBase64(bundle.authTag, 16, 'authTag');
  const encrypted = Buffer.from(bundle.encryptedPayload, 'base64');
  const { aadDigest: _aadDigest, ciphertextDigest: _ciphertextDigest, ...aadBase } = bundle.metadata;
  const decipher = createDecipheriv('aes-256-gcm', keys.encryptionKey, iv);
  decipher.setAAD(Buffer.from(metadataAad(aadBase), 'utf8'));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const payload: unknown = JSON.parse(decrypted.toString('utf8'));
  assertPayloadLimits(payload);
  if (containsSensitiveData(payload)) throw new Error('CAPTURE_REDACTION_FAILED: decrypted payload contains sensitive data.');
  return payload;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensurePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CAPTURE_PATH_UNSAFE: directory must be non-symlink.');
  return realpathSync(absolute);
}

function isConfined(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function writeAtomic(path: string, content: string): void {
  const parent = dirname(path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
  try {
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    syncDirectory(parent);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

export function writeCaptureBundle(bundleInput: CaptureBundle, capturesDir: string): string {
  const bundle = validateCaptureBundle(bundleInput);
  const root = ensurePrivateDirectory(capturesDir);
  const stamp = bundle.metadata.capturedAt.replace(/[-:.TZ]/gu, '').slice(0, 17);
  const filename = `${bundle.metadata.deviceScopeDigest}-${stamp}-${bundle.metadata.captureId}.enc`;
  const path = resolve(root, filename);
  if (!isConfined(root, path)) throw new Error('CAPTURE_PATH_UNSAFE: final path escaped capture root.');
  writeAtomic(path, `${JSON.stringify(bundle)}\n`);
  return path;
}

export function readCaptureBundle(filepath: string): CaptureBundle | null {
  try {
    const absolute = resolve(filepath);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CAPTURE_BUNDLE_MAX_BYTES * 2) return null;
    return validateCaptureBundle(JSON.parse(readFileSync(absolute, 'utf8')));
  } catch {
    return null;
  }
}

export function decryptCaptureBundleWithKeyring(bundleInput: CaptureBundle, keyring: CaptureKeyring): unknown {
  const bundle = validateCaptureBundle(bundleInput);
  const key = keyring.keys[bundle.metadata.keyId];
  if (!key) throw new Error('CAPTURE_KEYRING_UNAVAILABLE: bundle key is absent.');
  return decryptCaptureBundle(bundle, { encryptionKey: key, keyId: bundle.metadata.keyId });
}

export function readCapturePayload(filepath: string, keyring: CaptureKeyring): unknown {
  const bundle = readCaptureBundle(filepath);
  if (!bundle) throw new Error('INVALID_CAPTURE_BUNDLE: bundle is missing or corrupt.');
  return decryptCaptureBundleWithKeyring(bundle, keyring);
}

export function promoteCapturePayload(input: PromoteCaptureInput): CaptureBundleSummary {
  const capturedAt = input.capturedAt ?? new Date();
  if (!Number.isFinite(capturedAt.getTime())) throw new Error('INVALID_CAPTURE_BUNDLE: capturedAt is invalid.');
  const retentionMs = input.retentionMs ?? CAPTURE_DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) throw new Error('INVALID_CAPTURE_BUNDLE: retentionMs is invalid.');
  const captureId = input.captureId ?? randomUUID();
  const keyId = input.keyring.activeKeyId;
  const key = input.keyring.keys[keyId];
  if (!key) throw new Error('CAPTURE_KEYRING_UNAVAILABLE: active key is absent.');
  const metadata = {
    version: CAPTURE_BUNDLE_VERSION,
    keyId,
    captureId,
    deviceScopeDigest: computeDeviceScopeDigest(input.deviceScope),
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + retentionMs).toISOString(),
    product: input.product,
    ...(input.firmwareVersion === undefined ? {} : { firmwareVersion: input.firmwareVersion }),
  };
  const bundle = encryptCaptureBundle(input.payload, { encryptionKey: key, keyId }, metadata);
  const stagingRoot = ensurePrivateDirectory(input.stagingRoot);
  const stagingDir = ensurePrivateDirectory(join(stagingRoot, captureId));
  const stagedPath = join(stagingDir, 'bundle.enc');
  writeAtomic(stagedPath, `${JSON.stringify(bundle)}\n`);
  try {
    const staged = readCaptureBundle(stagedPath);
    if (!staged) throw new Error('INVALID_CAPTURE_BUNDLE: staged bundle verification failed.');
    decryptCaptureBundleWithKeyring(staged, input.keyring);
    const path = writeCaptureBundle(staged, input.capturesDir);
    const bytes = readFileSync(path);
    return {
      path,
      bundleDigest: sha256(bytes),
      ciphertextDigest: staged.metadata.ciphertextDigest,
      deviceScopeDigest: staged.metadata.deviceScopeDigest,
      captureId,
      capturedAt: staged.metadata.capturedAt,
      expiresAt: staged.metadata.expiresAt,
      product: staged.metadata.product,
      ...(staged.metadata.firmwareVersion === undefined ? {} : { firmwareVersion: staged.metadata.firmwareVersion }),
      keyId,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function validateRedactionCanary(bundle: CaptureBundle): boolean {
  try { return validateCaptureBundle(bundle).metadata.redactionCanary === REDACTION_CANARY; } catch { return false; }
}
