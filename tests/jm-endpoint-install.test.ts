import { describe, expect, it } from 'vitest';
import { planJmEndpointInstall } from '../scripts/lib/jm-endpoint-install.mjs';

/**
 * The endpoint installer is a *plan-first* tool: it decides the ordered install
 * steps for a JM host and reports them. Its safe path must never require
 * customer credentials, customer network access, or a device mutation, and it
 * must refuse to advertise an execution-enabling step it cannot gate.
 */

const linuxHost = { platform: 'linux', arch: 'x64', nodeMajor: 22 };

describe('planJmEndpointInstall', () => {
  it('plans the ordered dependency-then-browser-then-verify sequence', () => {
    const plan = planJmEndpointInstall({ host: linuxHost, env: {} });
    const ids = plan.steps.map((step) => step.id);
    expect(ids).toEqual([
      'corepack',
      'install_dependencies',
      'install_browser',
      'preflight',
      'mock_smoke',
    ]);
    expect(plan.steps.every((step) => typeof step.command === 'string' && step.command.length > 0)).toBe(true);
  });

  it('marks every safe-path step as requiring no customer credentials or network', () => {
    const plan = planJmEndpointInstall({ host: linuxHost, env: {} });
    expect(plan.steps.every((step) => step.requiresCustomerAccess === false)).toBe(true);
    expect(plan.requiresCustomerAccess).toBe(false);
  });

  it('never plans a device mutation or an execution-gate opt-in', () => {
    const plan = planJmEndpointInstall({ host: linuxHost, env: {} });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('SANGFOR_ALLOW_REAL_EXECUTION=true');
    expect(serialized).not.toContain('SANGFOR_ALLOW_PRODUCTION_EXECUTION=true');
    expect(plan.steps.every((step) => step.mutatesDevice === false)).toBe(true);
  });

  it('substitutes an explicit browser path step when the host cannot install one', () => {
    const plan = planJmEndpointInstall({
      host: linuxHost,
      env: { SANGFOR_CHROMIUM_PATH: '/opt/chromium/chrome' },
    });
    const browserStep = plan.steps.find((step) => step.id === 'install_browser');
    expect(browserStep?.skipped).toBe(true);
    expect(browserStep?.detail).toContain('SANGFOR_CHROMIUM_PATH');
  });

  it('reports doctor mode as read-only with a non-mutating command set', () => {
    const plan = planJmEndpointInstall({ host: linuxHost, env: {}, mode: 'doctor' });
    expect(plan.mode).toBe('doctor');
    expect(plan.readOnly).toBe(true);
    expect(plan.steps.every((step) => step.readOnly === true)).toBe(true);
  });

  it('refuses an unsupported node runtime instead of planning an install', () => {
    const plan = planJmEndpointInstall({ host: { ...linuxHost, nodeMajor: 18 }, env: {} });
    expect(plan.supported).toBe(false);
    expect(plan.reasons).toContain('NODE_VERSION_UNSUPPORTED');
  });

  it('flags a headless-server host so the operator knows a login profile needs a display', () => {
    const plan = planJmEndpointInstall({
      host: linuxHost,
      env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    });
    expect(plan.warnings).toContain('NO_DISPLAY_INTERACTIVE_LOGIN_REQUIRES_DISPLAY');
  });
});
