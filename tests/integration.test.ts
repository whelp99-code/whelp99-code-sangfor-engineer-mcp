import { describe, expect, it } from 'vitest';
import { generateIntegrationGuide, listIntegrationTypes } from '../packages/sangfor-integration/src/index.js';

describe('generateIntegrationGuide', () => {
  it('produces a cited step-by-step guide with prerequisites and validation for LDAP', () => {
    const g = generateIntegrationGuide('LDAP', 'IAG');
    expect(g).not.toBeNull();
    expect(g!.steps.length).toBeGreaterThan(0);
    expect(g!.prerequisites.length).toBeGreaterThan(0);
    expect(g!.validation.length).toBeGreaterThan(0);
    expect(g!.source).toBeTruthy();
  });

  it('normalizes AD to the LDAP/AD recipe and RADIUS/syslog aliases', () => {
    expect(generateIntegrationGuide('AD', 'IAG')).not.toBeNull();
    expect(generateIntegrationGuide('radius')).not.toBeNull();
    expect(generateIntegrationGuide('SIEM', 'CC')).not.toBeNull();
  });

  it('returns null (no fabrication) for an unknown integration type', () => {
    expect(generateIntegrationGuide('quantum-teleport' as any)).toBeNull();
  });

  it('lists the supported integration types', () => {
    const types = listIntegrationTypes();
    expect(types).toContain('LDAP');
    expect(types).toContain('RADIUS');
    expect(types).toContain('SIEM_SYSLOG');
  });
});
