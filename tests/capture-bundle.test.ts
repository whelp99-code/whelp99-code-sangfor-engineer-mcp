import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_BUNDLE_VERSION,
  captureKeyringFromEnv,
  computeDeviceScopeDigest,
  containsSensitiveData,
  decryptCaptureBundle,
  decryptCaptureBundleWithKeyring,
  encryptCaptureBundle,
  generateCaptureBundleKeys,
  parseCaptureKeyring,
  promoteCapturePayload,
  readCaptureBundle,
  readCapturePayload,
  validateCaptureBundle,
  validateRedactionCanary,
  writeCaptureBundle,
  type CaptureBundle,
} from '../packages/sangfor-collector/src/capture-bundle.js';

const DEVICE_SCOPE = '018f22e2-79b0-7cc3-8c3c-0f8e5d50a2bf';
const CAPTURED_AT = new Date('2026-07-28T00:00:00.000Z');

function metadata(keyId = 'key-1') {
  return {
    version: CAPTURE_BUNDLE_VERSION,
    keyId,
    captureId: 'capture-1',
    deviceScopeDigest: computeDeviceScopeDigest(DEVICE_SCOPE),
    capturedAt: CAPTURED_AT.toISOString(),
    expiresAt: new Date(CAPTURED_AT.getTime() + 86_400_000).toISOString(),
    product: 'FORTIOS',
    firmwareVersion: '8.0.0',
  } as const;
}

describe('PR-004 capture-bundle.v1', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'capture-bundle-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('requires a lowercase non-PII UUIDv7 and produces only its digest', () => {
    const digest = computeDeviceScopeDigest(DEVICE_SCOPE);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain(DEVICE_SCOPE);
    for (const invalid of ['device-123', '10.80.1.106', DEVICE_SCOPE.toUpperCase(), '018f22e2-79b0-4cc3-8c3c-0f8e5d50a2bf']) {
      expect(() => computeDeviceScopeDigest(invalid)).toThrow(/INVALID_DEVICE_SCOPE/u);
    }
  });

  it('parses only strict base64 32-byte keyrings with an existing active key', () => {
    const encoded = Buffer.alloc(32, 7).toString('base64');
    const keyring = parseCaptureKeyring(JSON.stringify({ 'key-1': encoded }), 'key-1');
    expect(keyring.keys['key-1']).toEqual(Buffer.alloc(32, 7));
    expect(captureKeyringFromEnv({
      SANGFOR_CAPTURE_BUNDLE_KEYS: JSON.stringify({ 'key-1': encoded }),
      SANGFOR_CAPTURE_BUNDLE_ACTIVE_KEY_ID: 'key-1',
    })).toMatchObject({ activeKeyId: 'key-1' });
    for (const [keys, active] of [
      [undefined, 'key-1'],
      ['{}', 'key-1'],
      [JSON.stringify({ 'key-1': Buffer.alloc(31).toString('base64') }), 'key-1'],
      [JSON.stringify({ 'key-1': `${encoded} ` }), 'key-1'],
      [JSON.stringify({ '../key': encoded }), '../key'],
    ] as Array<[string | undefined, string]>) {
      expect(() => parseCaptureKeyring(keys, active)).toThrow();
    }
  });

  it('binds metadata as AAD and rejects wrong key, tag, ciphertext, and metadata tampering', () => {
    const keys = generateCaptureBundleKeys('key-1');
    const payload = { events: [{ path: '/api/system/status', fields: ['version', 'license'] }] };
    const bundle = encryptCaptureBundle(payload, keys, metadata());
    expect(validateCaptureBundle(bundle)).toEqual(bundle);
    expect(validateRedactionCanary(bundle)).toBe(true);
    expect(decryptCaptureBundle(bundle, keys)).toEqual(payload);
    expect(() => decryptCaptureBundle(bundle, generateCaptureBundleKeys('key-1'))).toThrow();

    for (const mutate of [
      (copy: CaptureBundle) => { copy.authTag = Buffer.alloc(16, 1).toString('base64'); },
      (copy: CaptureBundle) => { copy.encryptedPayload = Buffer.from('tampered').toString('base64'); },
      (copy: CaptureBundle) => { copy.metadata.product = 'CISCO'; },
      (copy: CaptureBundle) => { copy.metadata.aadDigest = '0'.repeat(64); },
    ]) {
      const copy = structuredClone(bundle);
      mutate(copy);
      expect(() => decryptCaptureBundle(copy, keys)).toThrow();
    }
  });

  it('hard-denies secret/PII keys and values before encryption', () => {
    const keys = generateCaptureBundleKeys('key-1');
    for (const payload of [
      { password: 'value' },
      { nested: { authorization: 'value' } },
      { value: 'Bearer abcdefghijklmnop' },
      { value: 'user@example.com' },
      { value: '4111 1111 1111 1111' },
    ]) {
      expect(containsSensitiveData(payload)).toBe(true);
      expect(() => encryptCaptureBundle(payload, keys, metadata())).toThrow(/CAPTURE_REDACTION_FAILED/u);
    }
    expect(containsSensitiveData({ version: '8.0.0', status: 'valid' })).toBe(false);
  });

  it('enforces per-item and event-count limits', () => {
    const keys = generateCaptureBundleKeys('key-1');
    expect(() => encryptCaptureBundle({ item: 'x'.repeat(2 * 1024 * 1024 + 1) }, keys, metadata()))
      .toThrow(/CAPTURE_ITEM_TOO_LARGE/u);
    expect(() => encryptCaptureBundle({ events: Array.from({ length: 10_001 }, () => 1) }, keys, metadata()))
      .toThrow(/CAPTURE_EVENT_LIMIT/u);
  });

  it('atomically promotes an encrypted 0600 bundle and removes 0700 staging', () => {
    const key = Buffer.alloc(32, 0x42);
    const keyring = { activeKeyId: 'key-1', keys: { 'key-1': key } };
    const capturesDir = join(tempDir, 'captures');
    const stagingRoot = join(tempDir, 'runtime', 'learning-captures');
    const summary = promoteCapturePayload({
      payload: { events: [{ path: '/api/system/status', fields: ['version'] }] },
      deviceScope: DEVICE_SCOPE,
      product: 'FORTIOS',
      firmwareVersion: '8.0.0',
      capturesDir,
      stagingRoot,
      keyring,
      captureId: 'capture-1',
      capturedAt: CAPTURED_AT,
    });
    expect(summary.path).toMatch(new RegExp(`${summary.deviceScopeDigest}-\\d{17}-capture-1\\.enc$`, 'u'));
    expect(summary.path).not.toMatch(/FORTIOS|10\.80|device/iu);
    expect(statSync(summary.path).mode & 0o777).toBe(0o600);
    expect(statSync(capturesDir).mode & 0o777).toBe(0o700);
    expect(statSync(stagingRoot).mode & 0o777).toBe(0o700);
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(readCapturePayload(summary.path, keyring)).toEqual({ events: [{ path: '/api/system/status', fields: ['version'] }] });
    expect(readFileSync(summary.path, 'utf8')).not.toContain('/api/system/status');
    expect(summary.bundleDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('writes/reads strict envelopes and refuses symlink or corrupt input', () => {
    const keys = generateCaptureBundleKeys('key-1');
    const bundle = encryptCaptureBundle({ status: 'ok' }, keys, metadata());
    const path = writeCaptureBundle(bundle, join(tempDir, 'captures'));
    expect(readCaptureBundle(path)).toEqual(bundle);
    expect(decryptCaptureBundleWithKeyring(bundle, { activeKeyId: 'key-1', keys: { 'key-1': keys.encryptionKey } }))
      .toEqual({ status: 'ok' });

    const link = join(tempDir, 'linked.enc');
    symlinkSync(path, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readCaptureBundle(link)).toBeNull();
    const corrupt = join(tempDir, 'corrupt.enc');
    writeFileSync(corrupt, '{"version":1}');
    expect(readCaptureBundle(corrupt)).toBeNull();
    expect(readCaptureBundle(join(tempDir, 'missing.enc'))).toBeNull();
  });
});
