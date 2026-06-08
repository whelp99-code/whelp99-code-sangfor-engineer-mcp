import { describe, expect, it } from 'vitest';
import { captureProductScreenshots } from '../packages/sangfor-screenshot/src/index.js';

describe('Screenshot Collector', () => {
  it('returns dry-run result for EPP without connecting to Chrome', async () => {
    const result = await captureProductScreenshots({ product: 'EPP', dryRun: true });

    expect(result.product).toBe('EPP');
    expect(result.captured.length).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);
    expect(result.totalScreenshots).toBeGreaterThan(0);
    expect(result.timestamp).toBeTruthy();
    expect(result.captured[0]).toContain('[dry-run]');
  });

  it('returns dry-run result for IAG', async () => {
    const result = await captureProductScreenshots({ product: 'IAG', dryRun: true });

    expect(result.product).toBe('IAG');
    expect(result.captured.length).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);
  });

  it('returns dry-run result for CC', async () => {
    const result = await captureProductScreenshots({ product: 'CC', dryRun: true });

    expect(result.product).toBe('CC');
    expect(result.captured.length).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);
  });

  it('supports custom menus in dry-run', async () => {
    const result = await captureProductScreenshots({
      product: 'EPP',
      dryRun: true,
      menus: [
        { menu: 'Dashboard' },
        { menu: 'Policy', submenu: 'Malware/Ransomware Protection' },
      ],
    });

    expect(result.totalScreenshots).toBe(2);
    expect(result.captured[0]).toContain('Dashboard');
    expect(result.captured[1]).toContain('Malware/Ransomware Protection');
  });
});
