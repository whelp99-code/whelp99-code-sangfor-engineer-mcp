import { describe, expect, it } from 'vitest';
import {
  getCapabilitySafety,
  listCapabilitySafety,
  loadMaturityPolicy,
  loadSafetyPolicy,
} from '../packages/sangfor-safety/src/index.js';

describe('capability safety policy', () => {
  it('defaults unknown capabilities to human_only', () => {
    const summary = getCapabilitySafety('IAG', 'unknown_capability');

    expect(summary.safetyClass).toBe('human_only');
    expect(summary.autoAllowed).toBe(false);
    expect(summary.fieldVerifiedAutoAllowed).toBe(false);
  });

  it('keeps safety_class and maturity as separate physical files', () => {
    const safety = loadSafetyPolicy();
    const maturity = loadMaturityPolicy();

    expect(safety.entries.length).toBeGreaterThan(0);
    expect(maturity.entries.length).toBeGreaterThan(0);
    expect(safety.entries[0]).toHaveProperty('safetyClass');
    expect(safety.entries[0]).not.toHaveProperty('maturity');
    expect(maturity.entries[0]).toHaveProperty('maturity');
    expect(maturity.entries[0]).not.toHaveProperty('safetyClass');
  });

  it('normalizes Endpoint Secure aliases for safety lookup', () => {
    const summary = getCapabilitySafety('EPP', 'agent_deployment');

    expect(summary.product).toBe('ENDPOINT_SECURE');
    expect(summary.safetyClass).toBe('human_only');
    expect(summary.autoAllowed).toBe(false);
  });

  it('does not count implemented-local advisory work as field-verified auto-allowed execution', () => {
    const summary = getCapabilitySafety('IAG', 'auth_source');

    expect(summary.safetyClass).toBe('read_only');
    expect(summary.maturity).toBe('implemented_local');
    expect(summary.autoAllowed).toBe(false);
    expect(summary.fieldVerifiedAutoAllowed).toBe(false);
  });

  it('lists combined safety and maturity coverage for dashboard/tooling use', () => {
    const capabilities = listCapabilitySafety();

    expect(capabilities).toContainEqual(expect.objectContaining({
      product: 'IAG',
      capabilityId: 'auth_source',
      safetyClass: 'read_only',
      maturity: 'implemented_local',
    }));
  });
});
