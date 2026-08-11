import { describe, expect, it } from 'vitest';
import {
  assertOwnedCdpBinding,
  loopbackCdpEndpoint,
  resolvePlaywrightLaunchOptions,
  shouldIgnoreHttpsErrors,
} from '../packages/sangfor-jm-execution/src/playwright-driver.js';

describe('JM Playwright launch options', () => {
  it('uses an explicitly configured absolute Chromium executable', () => {
    expect(resolvePlaywrightLaunchOptions({
      headless: true,
      sessionChromiumPath: '/opt/jm/chromium',
    })).toEqual({
      headless: true,
      executablePath: '/opt/jm/chromium',
    });
  });

  it('rejects ambiguous relative executable paths', () => {
    expect(() => resolvePlaywrightLaunchOptions({
      headless: true,
      configuredChromiumPath: 'chromium',
    })).toThrow(/absolute/i);
  });

  it('constructs CDP endpoints only from safe integer ports', () => {
    expect(loopbackCdpEndpoint(9333)).toBe('http://127.0.0.1:9333');
    expect(() => loopbackCdpEndpoint('9333@attacker.example:80/')).toThrow(/CDP_PORT_INVALID/);
  });

  it.each([
    ['mock', true],
    ['lab', true],
    ['poc', true],
    ['customer_readonly', false],
    ['customer_write', false],
    ['production', false],
  ] as const)('sets TLS bypass for %s mode to %s', (mode, expected) => {
    expect(shouldIgnoreHttpsErrors(mode, 'http://127.0.0.1:3400/hci')).toBe(expected);
  });

  it('does not bypass TLS for a non-loopback target declared as lab', () => {
    expect(shouldIgnoreHttpsErrors(
      'lab',
      'https://production-device.example/admin',
    )).toBe(false);
  });

  it('requires a trusted port-and-origin profile before borrowed CDP attach', () => {
    delete process.env.SANGFOR_JM_CDP_PROFILES_JSON;
    const session = {
      sessionId: 'borrowed-session',
      origin: 'http://127.0.0.1:3400',
      mode: 'lab',
      cdpPort: 9333,
    } as const;

    expect(() => assertOwnedCdpBinding(session)).toThrow(/CDP_PROFILE_REQUIRED/);
    process.env.SANGFOR_JM_CDP_PROFILES_JSON = JSON.stringify([{
      profileRef: 'qa-console',
      cdpPort: 9333,
      expectedOrigin: 'http://127.0.0.1:3400',
    }]);
    expect(() => assertOwnedCdpBinding(session)).not.toThrow();
    delete process.env.SANGFOR_JM_CDP_PROFILES_JSON;
  });
});
