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

  it('records official SCP Janus extras reads from the retrieved 2024 Open-API PDF', () => {
    expect(catalog.services.scpJanus.source.url).toBe(
      'https://zhuge-puboss.sangfor.com/qiyu/c712a4ec7eb199fbf6dbf0e78a6cc93f.pdf/Open-API-zh_CN-2024-05-15.pdf',
    );
    expect(catalog.services.scpJanus.extrasReadOnly).toEqual(['GET /janus/20180725/hosts']);
    expect(catalog.services.scpJanus.extrasFieldMap).toEqual({
      host_cpu: 'GET /janus/20180725/hosts',
      host_ram: 'GET /janus/20180725/hosts',
    });
    expect(catalog.services.scpJanus.notDocumented).toEqual(expect.arrayContaining([
      'ha_status',
      'collectedAt',
      'network_topology',
      'GET /os-hypervisors',
    ]));
    const services = catalog.services as Record<string, { readOnly?: readonly string[] }>;
    const catalogReads = Object.values(services).flatMap((service) => service.readOnly ?? []);
    expect(catalogReads).not.toContain('GET /os-hypervisors');
    expect(catalog.services.scpJanus.extrasReadOnly).not.toContain('GET /os-hypervisors');
  });
});
