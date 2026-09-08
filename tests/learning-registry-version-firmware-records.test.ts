import { describe, expect, it } from 'vitest';
import {
  canonicalizeFingerprintDescriptors,
  fingerprintFromDescriptors,
  parseFirmwareTruthRecord,
  sameFirmwareIdentity,
} from '../packages/sangfor-version/src/index.js';

describe('PR-001A1 firmware truth record parsing and descriptor fingerprints', () => {
  it('strictly parses truth records, fingerprints allowlisted descriptors, and preserves identity equality', () => {
    const record = parseFirmwareTruthRecord({
      id: 'iag-13.0.120-candidate',
      vendor: 'SANGFOR',
      adapterProduct: 'IAG',
      productVariant: null,
      versionRaw: '13.0.120',
      versionFamily: '13.0',
      revision: 'R1',
      buildId: 'build-7',
      hotfix: 'HF-2',
      uiFingerprint: 'a'.repeat(64),
      apiFingerprint: 'b'.repeat(64),
      status: 'candidate',
      observedAt: '2026-07-23T00:00:00.000Z',
      evidenceFile: 'evidence.json',
      specVersion: '13.0.120',
      specApplicability: 'unreviewed',
      source: 'test fixture',
    });
    expect(record.versionRaw).toBe('13.0.120');
    expect(() => parseFirmwareTruthRecord({ ...record, unexpected: true })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, vendor: 'UNKNOWN' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, status: 'published' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, specApplicability: 'approved' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, observedAt: 'not-a-timestamp' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, observedAt: '2026-02-30T10:41:30.863Z' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, uiFingerprint: 'not-a-hash' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, productVariant: '' })).toThrow('INVALID_FIRMWARE_TRUTH');
    for (const specVersion of [
      '.', '..', '../EPP/6.0.4', 'EPP/6.0.4', 'EPP\\6.0.4', '/6.0.4', 'C:\\6.0.4',
      ' 6.0.4', '6.0.4 ', '6.0 4', '6.0.4\u0000', '6.0.4\n', 'v'.repeat(65),
    ]) {
      expect(() => parseFirmwareTruthRecord({ ...record, specVersion })).toThrow('INVALID_FIRMWARE_TRUTH');
    }
    for (const specVersion of ['3.0.98', '6.0.4R4', '8.0.0-build_1+hotfix']) {
      expect(parseFirmwareTruthRecord({ ...record, specVersion }).specVersion).toBe(specVersion);
    }
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: '/etc/hosts' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: '../evidence.json' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: null })).not.toThrow();
    expect(() => parseFirmwareTruthRecord({ ...record, status: 'verified', specApplicability: 'verified', evidenceFile: null })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, source: undefined })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(sameFirmwareIdentity(record, { ...record, id: 'iag-13.0.120-other' })).toBe(true);
    expect(sameFirmwareIdentity(record, { ...record, versionRaw: '13.0.120R1' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, revision: 'R2' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, buildId: 'build-8' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, hotfix: 'HF-3' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, uiFingerprint: 'c'.repeat(64) })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, apiFingerprint: 'd'.repeat(64) })).toBe(false);

    const descriptor = {
      buildId: 'build-7',
      assetManifestId: 'assets-1',
      framework: { name: 'vue', version: '3.5.0' },
      routeSignature: ['https://host-a/dashboard?token=alpha&customer=acme#x', 'system'],
      apiSchemaSignature: 'api-schema',
      hostname: '10.0.0.1',
      origin: 'https://device.example.test',
      serial: 'SERIAL-123',
      license: 'LICENSE-123',
      customer: 'customer-123',
      user: 'admin',
      token: 'must-not-be-included',
      observedAt: '2026-07-23T00:00:00.000Z',
    };
    const reordered = {
      routeSignature: ['https://host-b/dashboard?token=beta&customer=other#different', ' system '],
      framework: { ignored: 'nested-secret', version: '3.5.0', name: 'vue', token: 'nested-token' },
      frameworkVersion: '3.5.0',
      rawBuildId: 'build-7',
      apiSchemaSignature: 'api-schema',
      assetManifestId: 'assets-1',
      time: '2026-07-23T00:00:00.000Z',
    };
    const canonical = canonicalizeFingerprintDescriptors(descriptor);
    const canonicalValue = JSON.parse(canonical) as Record<string, unknown>;
    expect(canonical).not.toContain('build-7');
    expect(canonical).not.toContain('assets-1');
    expect(canonical).not.toContain('api-schema');
    expect(canonical).not.toContain('dashboard');
    expect(canonical).not.toContain('system');
    for (const secret of ['10.0.0.1', 'https://device.example.test', 'host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'SERIAL-123', 'LICENSE-123', 'customer-123', 'admin', 'must-not-be-included']) {
      expect(canonical).not.toContain(secret);
    }
    expect(canonicalValue.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.assetManifestId).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.apiSchemaSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.routeSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(canonicalValue.framework as Record<string, unknown>)).toEqual(['name', 'version']);
    expect((canonicalValue.framework as Record<string, unknown>).name).toMatch(/^[a-f0-9]{64}$/);
    expect((canonicalValue.framework as Record<string, unknown>).version).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.buildId).not.toBe(canonicalValue.assetManifestId);
    expect(canonicalizeFingerprintDescriptors(reordered)).toBe(canonical);
    const hashDashboard = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-a/index.html#/dashboard?token=alpha&customer=acme#secondary'],
    });
    const hashDashboardOtherOrigin = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-b/index.html#/dashboard?token=beta&customer=other#different'],
    });
    const hashSystem = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-a/index.html#/system?token=alpha&customer=acme#secondary'],
    });
    expect(hashDashboardOtherOrigin).toBe(hashDashboard);
    expect(hashSystem).not.toBe(hashDashboard);
    const dashboardPath = canonicalizeFingerprintDescriptors({ routeSignature: ['/dashboard'] });
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['/dashboard#system'] })).toBe(dashboardPath);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/dashboard#system'] })).toBe(dashboardPath);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/dashboard#'] })).toBe(dashboardPath);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/dashboard#!'] })).toBe(dashboardPath);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/dashboard#/system'] })).toBe(hashSystem);
    for (const route of ['#/dashboard', '/#/dashboard', '#!/dashboard', 'index.html#/dashboard']) {
      expect(canonicalizeFingerprintDescriptors({ routeSignature: [route] })).toBe(hashDashboard);
    }
    for (const secret of ['host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'secondary', 'different']) {
      expect(hashDashboard).not.toContain(secret);
    }
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['/policy/:customerId'] }))
      .toBe(canonicalizeFingerprintDescriptors({ routeSignature: ['/policy/{customerId}'] }));
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['/policy/:customerId'] }))
      .not.toBe(canonicalizeFingerprintDescriptors({ routeSignature: ['/policy/:userId'] }));
    for (const route of ['/policy/:acme', '/policy/{other}', '/policy/:eyJhbGciOiJIUzI1NiJ9']) {
      expect(() => canonicalizeFingerprintDescriptors({ routeSignature: [route] })).toThrow('INVALID_FIRMWARE_TRUTH');
    }
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['#/POLICY/ANTIMALWARE'] }))
      .toBe(canonicalizeFingerprintDescriptors({ routeSignature: ['#/policy/antiMalware'] }));
    const actualRepositoryRoutes = [
      'index', 'policy/antiMalware', 'scan', 'policy/appControl', 'policy/deviceControl', 'event', 'deployment',
      'home', 'monitor/user_manager', 'audit/dlp_event', 'policy/access_policy', 'auth/endpoint_check',
      'log/internet_log', 'overview', 'detection/log', 'detection/threat', 'response',
    ];
    for (const route of actualRepositoryRoutes) {
      const noSlash = canonicalizeFingerprintDescriptors({ routeSignature: [`#${route}`] });
      expect(canonicalizeFingerprintDescriptors({ routeSignature: [`#/${route}?token=route#secondary`] }))
        .toBe(noSlash);
      expect(canonicalizeFingerprintDescriptors({ routeSignature: [`https://host-a/index.html#${route}?customer=route#secondary`] }))
        .toBe(noSlash);
    }
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['#detection/log'] }))
      .not.toBe(canonicalizeFingerprintDescriptors({ routeSignature: ['#detection/threat'] }));
    const rootRoute = canonicalizeFingerprintDescriptors({ routeSignature: ['#'] });
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['#!/'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['#/'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/index.html'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/index.htm'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['index.html'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['index.htm'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/index.html#'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/'] })).toBe(rootRoute);
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-b/index.html#/'] })).toBe(rootRoute);
    expect(rootRoute).not.toBe(hashDashboard);
    expect(rootRoute).not.toBe(hashSystem);
    for (const route of [
      '/customers/acme', '/token/alpha', '/users/admin', '/devices/SERIAL123',
      '/reports/123', '/reports/550e8400-e29b-41d4-a716-446655440000',
      '/reports/abcdefabcdefabcdef', '/reports/192.168.1.1', '/reports/admin@example.com',
      '/org/acme', '/organization/acme', '/apiKeys/AbCdEf123456', '/profile/jmpark',
      '/reports/acme-2026', '/download/<JWT-like>',
    ]) {
      expect(() => canonicalizeFingerprintDescriptors({ routeSignature: [route] })).toThrow('INVALID_FIRMWARE_TRUTH');
    }
    const nestedFrameworkVersion = canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue', version: '3.5.0' },
    });
    const topLevelFrameworkVersion = canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue' },
      frameworkVersion: '3.5.0',
    });
    expect(topLevelFrameworkVersion).toBe(nestedFrameworkVersion);
    expect(fingerprintFromDescriptors({ buildId: 'build-7', framework: { name: 'vue', version: '3.5.0' } }))
      .toBe(fingerprintFromDescriptors({ buildId: 'build-7', framework: { name: 'vue' }, frameworkVersion: '3.5.0' }));
    expect(() => canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue', version: '3.5.0' },
      frameworkVersion: '3.5.1',
    })).toThrow('INVALID_FIRMWARE_TRUTH');
    const fingerprint = fingerprintFromDescriptors(descriptor);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of ['build-7', 'assets-1', 'api-schema', 'dashboard', 'system', '10.0.0.1', 'host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'SERIAL-123', 'LICENSE-123', 'customer-123', 'admin', 'must-not-be-included']) {
      expect(fingerprint).not.toContain(secret);
    }
    expect(fingerprintFromDescriptors(reordered)).toBe(fingerprint);
    expect(() => canonicalizeFingerprintDescriptors({})).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors(null)).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors([])).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ hostname: '10.0.0.1', token: 'only-secret' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ buildId: 123 })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ framework: 'vue' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['ok', 7] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: [] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://user:pass@host-a/dashboard'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://[invalid/dashboard'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/%ZZ'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['dashboard\u0000'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ buildId: 'x'.repeat(257) })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: Array.from({ length: 65 }, () => 'route') })).toThrow('INVALID_FIRMWARE_TRUTH');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeFingerprintDescriptors(cyclic)).toThrow('INVALID_FIRMWARE_TRUTH');
    const cyclicRoutes: unknown[] = [];
    cyclicRoutes.push(cyclicRoutes);
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: cyclicRoutes })).toThrow('INVALID_FIRMWARE_TRUTH');
  });
});
