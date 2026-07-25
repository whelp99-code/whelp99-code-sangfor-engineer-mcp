import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encryptCaptureBundle,
  decryptCaptureBundle,
  writeCaptureBundle,
  readCaptureBundle,
  generateCaptureBundleKeys,
  computeDeviceScopeDigest,
  validateRedactionCanary,
  containsSensitiveData,
  type CaptureBundle,
} from '../packages/sangfor-collector/src/capture-bundle.js';

describe('PR-004: Capture bundle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'capture-bundle-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('computeDeviceScopeDigest', () => {
    it('produces deterministic SHA-256 hex digest', () => {
      const digest1 = computeDeviceScopeDigest('device-123');
      const digest2 = computeDeviceScopeDigest('device-123');
      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different digests for different scopes', () => {
      const digest1 = computeDeviceScopeDigest('device-123');
      const digest2 = computeDeviceScopeDigest('device-456');
      expect(digest1).not.toBe(digest2);
    });
  });

  describe('generateCaptureBundleKeys', () => {
    it('generates 32-byte encryption key', () => {
      const keys = generateCaptureBundleKeys();
      expect(keys.encryptionKey).toHaveLength(32);
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('encrypts and decrypts payload correctly', () => {
      const keys = generateCaptureBundleKeys();
      const payload = { version: '8.0.0', license: 'valid' };
      const metadata = {
        version: 'capture-bundle.v1' as const,
        deviceScopeDigest: computeDeviceScopeDigest('device-123'),
        capturedAt: new Date().toISOString(),
        product: 'FORTIOS',
      };

      const bundle = encryptCaptureBundle(payload, keys, metadata);
      const decrypted = decryptCaptureBundle(bundle, keys);

      expect(decrypted).toEqual(payload);
    });

    it('fails to decrypt with wrong key', () => {
      const keys1 = generateCaptureBundleKeys();
      const keys2 = generateCaptureBundleKeys();
      const payload = { version: '8.0.0' };
      const metadata = {
        version: 'capture-bundle.v1' as const,
        deviceScopeDigest: computeDeviceScopeDigest('device-123'),
        capturedAt: new Date().toISOString(),
        product: 'FORTIOS',
      };

      const bundle = encryptCaptureBundle(payload, keys1, metadata);

      expect(() => decryptCaptureBundle(bundle, keys2)).toThrow();
    });
  });

  describe('write/read round-trip', () => {
    it('writes and reads bundle from disk', () => {
      const keys = generateCaptureBundleKeys();
      const payload = { version: '8.0.0' };
      const metadata = {
        version: 'capture-bundle.v1' as const,
        deviceScopeDigest: computeDeviceScopeDigest('device-123'),
        capturedAt: new Date().toISOString(),
        product: 'FORTIOS',
      };

      const bundle = encryptCaptureBundle(payload, keys, metadata);
      const capturesDir = join(tempDir, 'captures');
      const filepath = writeCaptureBundle(bundle, capturesDir);

      expect(existsSync(filepath)).toBe(true);
      expect(filepath).toContain('.enc');

      const readBundle = readCaptureBundle(filepath);
      expect(readBundle).not.toBeNull();
      expect(readBundle!.metadata.deviceScopeDigest).toBe(metadata.deviceScopeDigest);
    });

    it('returns null for non-existent file', () => {
      const result = readCaptureBundle(join(tempDir, 'nonexistent.enc'));
      expect(result).toBeNull();
    });
  });

  describe('validateRedactionCanary', () => {
    it('returns true for valid canary', () => {
      const keys = generateCaptureBundleKeys();
      const payload = { version: '8.0.0' };
      const metadata = {
        version: 'capture-bundle.v1' as const,
        deviceScopeDigest: computeDeviceScopeDigest('device-123'),
        capturedAt: new Date().toISOString(),
        product: 'FORTIOS',
      };

      const bundle = encryptCaptureBundle(payload, keys, metadata);
      expect(validateRedactionCanary(bundle)).toBe(true);
    });
  });

  describe('containsSensitiveData', () => {
    it('detects password patterns', () => {
      expect(containsSensitiveData({ password: 'secret123' })).toBe(true);
      expect(containsSensitiveData({ config: 'password=admin' })).toBe(true);
    });

    it('detects email addresses', () => {
      expect(containsSensitiveData({ email: 'user@example.com' })).toBe(true);
    });

    it('returns false for clean data', () => {
      expect(containsSensitiveData({ version: '8.0.0', license: 'valid' })).toBe(false);
    });
  });
});
