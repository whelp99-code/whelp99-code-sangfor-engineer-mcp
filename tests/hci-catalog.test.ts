import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('hci api catalog', () => {
  const catalog = JSON.parse(readFileSync('data/hci-api/catalog.json', 'utf8'));

  it('carries the honesty label until M4 verifies it on a real device', () => {
    expect(catalog.source.contractStatus).toBe('doc_contract_unverified_on_real_device');
  });

  it('pins the read-back trap note on the volume service', () => {
    expect(catalog.services.volume.trap).toMatch(/202 is NOT proof of effect/);
  });

  it('gates janus behind real-device capture', () => {
    expect(catalog.services.scpJanus.status).toBe('capture_gated');
  });
});
