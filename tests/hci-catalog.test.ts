import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('hci api catalog', () => {
  const catalog = JSON.parse(readFileSync('data/hci-api/catalog.json', 'utf8'));

  it('carries the honesty label reflecting the M4 real-device verification', () => {
    expect(catalog.source.contractStatus).toBe('auth_verified_on_10.80.1.104_2026-07-02; volume_service_unavailable_503');
  });

  it('pins the read-back trap note on the volume service', () => {
    expect(catalog.services.volume.trap).toMatch(/202 is NOT proof of effect/);
  });

  it('gates janus behind real-device capture', () => {
    expect(catalog.services.scpJanus.status).toBe('capture_gated');
  });
});
