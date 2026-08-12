import { describe, expect, it } from 'vitest';
import { evaluateJmEndpointPreflight } from '../scripts/lib/jm-endpoint-preflight.mjs';

/**
 * JM endpoint preflight is a fail-closed readiness gate for the client-side
 * browser execution edge. It must never report READY on partial evidence, and
 * every refusal must carry an explicit machine-readable reason code.
 */

const okProbes = {
  executableExists: () => true,
  cdpEndpointOrigin: () => 'https://console.example.com',
  nodeMajor: () => 22,
};

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SANGFOR_CHROMIUM_PATH: '/opt/chromium/chrome',
    SANGFOR_JM_CDP_PROFILES_JSON: JSON.stringify([
      { profileRef: 'approved-console', cdpPort: 9333, expectedOrigin: 'https://console.example.com' },
    ]),
    ...overrides,
  };
}

describe('evaluateJmEndpointPreflight', () => {
  it('reports READY only when every required check passes', () => {
    const report = evaluateJmEndpointPreflight({ env: baseEnv(), probes: okProbes });
    expect(report.ready).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.reasons).toEqual([]);
    expect(report.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('refuses when no browser executable is configured', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({ SANGFOR_CHROMIUM_PATH: undefined }),
      probes: okProbes,
    });
    expect(report.ready).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.reasons).toContain('BROWSER_EXECUTABLE_UNSET');
  });

  it('refuses when the configured browser executable is not present', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv(),
      probes: { ...okProbes, executableExists: () => false },
    });
    expect(report.reasons).toContain('BROWSER_EXECUTABLE_MISSING');
    expect(report.ready).toBe(false);
  });

  it('refuses a corrupt CDP profile registry instead of ignoring it', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({ SANGFOR_JM_CDP_PROFILES_JSON: '{not json' }),
      probes: okProbes,
    });
    expect(report.reasons).toContain('CDP_PROFILE_REGISTRY_CORRUPT');
    expect(report.ready).toBe(false);
  });

  it('refuses a CDP profile bound to a non-loopback debugging host', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({
        SANGFOR_JM_CDP_PROFILES_JSON: JSON.stringify([
          {
            profileRef: 'remote',
            cdpPort: 9333,
            expectedOrigin: 'https://console.example.com',
            cdpHost: '0.0.0.0',
          },
        ]),
      }),
      probes: okProbes,
    });
    expect(report.reasons).toContain('CDP_BIND_NOT_LOOPBACK');
    expect(report.ready).toBe(false);
  });

  it('refuses a CDP profile whose expected origin is not an exact https origin', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({
        SANGFOR_JM_CDP_PROFILES_JSON: JSON.stringify([
          { profileRef: 'pathy', cdpPort: 9333, expectedOrigin: 'https://console.example.com/login' },
        ]),
      }),
      probes: okProbes,
    });
    expect(report.reasons).toContain('CDP_PROFILE_ORIGIN_INVALID');
    expect(report.ready).toBe(false);
  });

  it('requires the approval secret once real execution is enabled', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({ SANGFOR_ALLOW_REAL_EXECUTION: 'true' }),
      probes: okProbes,
    });
    expect(report.reasons).toContain('APPROVAL_SECRET_MISSING');
    expect(report.ready).toBe(false);
  });

  it('requires the production opt-in for a non-loopback mutation target', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({
        SANGFOR_ALLOW_REAL_EXECUTION: 'true',
        SANGFOR_OPERATOR_APPROVAL_SECRET: 'x'.repeat(32),
        SANGFOR_CONSOLE_URL: 'https://console.example.com',
      }),
      probes: okProbes,
    });
    expect(report.reasons).toContain('PRODUCTION_OPT_IN_REQUIRED');
    expect(report.ready).toBe(false);
  });

  it('accepts a loopback mutation target without the production opt-in', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({
        SANGFOR_ALLOW_REAL_EXECUTION: 'true',
        SANGFOR_OPERATOR_APPROVAL_SECRET: 'x'.repeat(32),
        SANGFOR_CONSOLE_URL: 'http://127.0.0.1:3400',
      }),
      probes: okProbes,
    });
    expect(report.reasons).not.toContain('PRODUCTION_OPT_IN_REQUIRED');
    expect(report.ready).toBe(true);
  });

  it('refuses an unsupported Node runtime', () => {
    const report = evaluateJmEndpointPreflight({
      env: baseEnv(),
      probes: { ...okProbes, nodeMajor: () => 18 },
    });
    expect(report.reasons).toContain('NODE_VERSION_UNSUPPORTED');
    expect(report.ready).toBe(false);
  });

  it('never masks a secret value into the report', () => {
    const secret = 'super-secret-approval-key-value-000';
    const report = evaluateJmEndpointPreflight({
      env: baseEnv({
        SANGFOR_ALLOW_REAL_EXECUTION: 'true',
        SANGFOR_OPERATOR_APPROVAL_SECRET: secret,
        SANGFOR_CONSOLE_URL: 'http://127.0.0.1:3400',
      }),
      probes: okProbes,
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
