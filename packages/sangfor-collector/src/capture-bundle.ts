import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * PR-004: T-H2 통합 encrypted bundle.
 * 
 * capture-bundle.v1: AES-GCM encrypted capture bundle format.
 * 
 * Security requirements:
 * - data/captures/** is local-only (gitignored)
 * - Opaque deviceScopeDigest filename (no hostname/IP/serial)
 * - AES-GCM encryption with authentication tag
 * - Redaction canary for secrets/PII
 */

export interface CaptureBundleMetadata {
  version: 'capture-bundle.v1';
  deviceScopeDigest: string;
  capturedAt: string;
  product: string;
  firmwareVersion?: string;
  redactionCanary: string;
}

export interface CaptureBundle {
  metadata: CaptureBundleMetadata;
  encryptedPayload: string; // base64 encoded
  iv: string; // base64 encoded
  authTag: string; // base64 encoded
}

export interface CaptureBundleKeys {
  encryptionKey: Buffer; // 32 bytes for AES-256-GCM
}

const REDACTION_CANARY = 'REDACTION_CANARY_NO_SECRETS_PRESENT';

export function computeDeviceScopeDigest(deviceScope: string): string {
  return createHash('sha256').update(deviceScope).digest('hex');
}

export function generateCaptureBundleKeys(): CaptureBundleKeys {
  return {
    encryptionKey: randomBytes(32),
  };
}

export function encryptCaptureBundle(
  payload: unknown,
  keys: CaptureBundleKeys,
  metadata: Omit<CaptureBundleMetadata, 'redactionCanary'>,
): CaptureBundle {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', keys.encryptionKey, iv);

  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    metadata: {
      ...metadata,
      redactionCanary: REDACTION_CANARY,
    },
    encryptedPayload: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptCaptureBundle(
  bundle: CaptureBundle,
  keys: CaptureBundleKeys,
): unknown {
  const iv = Buffer.from(bundle.iv, 'base64');
  const authTag = Buffer.from(bundle.authTag, 'base64');
  const encrypted = Buffer.from(bundle.encryptedPayload, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', keys.encryptionKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

export function writeCaptureBundle(
  bundle: CaptureBundle,
  capturesDir: string,
): string {
  mkdirSync(capturesDir, { recursive: true });
  const filename = `${bundle.metadata.deviceScopeDigest}.enc`;
  const filepath = join(capturesDir, filename);
  writeFileSync(filepath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return filepath;
}

export function readCaptureBundle(filepath: string): CaptureBundle | null {
  if (!existsSync(filepath)) return null;
  try {
    const content = readFileSync(filepath, 'utf8');
    return JSON.parse(content) as CaptureBundle;
  } catch {
    return null;
  }
}

export function validateRedactionCanary(bundle: CaptureBundle): boolean {
  return bundle.metadata.redactionCanary === REDACTION_CANARY;
}

/**
 * Redaction patterns for secrets/PII.
 * These patterns are used to detect and reject bundles containing sensitive data.
 */
export const REDACTION_PATTERNS = [
  /password/gi,
  /secret/gi,
  /token/gi,
  /api[_-]?key/gi,
  /authorization/gi,
  /cookie/gi,
  /\b(?:\d[ -]*?){13,16}\b/g, // credit card numbers
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // email addresses
];

export function containsSensitiveData(payload: unknown): boolean {
  const serialized = JSON.stringify(payload);
  return REDACTION_PATTERNS.some(pattern => pattern.test(serialized));
}
