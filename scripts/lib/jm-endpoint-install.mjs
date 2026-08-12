/**
 * JM endpoint install planner.
 *
 * Decides the ordered steps that turn a bare host into a JM browser execution
 * edge. Pure planning: the CLI decides whether to print or run the plan, so the
 * step contract is testable without touching the host.
 *
 * Safety contract:
 * - the safe path never needs customer credentials or customer network access;
 * - no step mutates a device;
 * - no step enables an execution gate. Enabling real/production execution stays
 *   a deliberate, human, per-window action documented in the runbook.
 */

const MINIMUM_NODE_MAJOR = 20;

function step(input) {
  return {
    id: input.id,
    title: input.title,
    command: input.command,
    detail: input.detail,
    readOnly: input.readOnly ?? false,
    skipped: input.skipped ?? false,
    requiresCustomerAccess: false,
    mutatesDevice: false,
  };
}

/**
 * @param {object} input
 * @param {{platform: string, arch: string, nodeMajor: number}} input.host
 * @param {Record<string, string | undefined>} input.env
 * @param {'install' | 'doctor'} [input.mode]
 */
export function planJmEndpointInstall(input) {
  const host = input?.host ?? { platform: 'unknown', arch: 'unknown', nodeMajor: 0 };
  const env = input?.env ?? {};
  const mode = input?.mode === 'doctor' ? 'doctor' : 'install';
  const readOnly = mode === 'doctor';

  const reasons = [];
  const warnings = [];

  if (!(host.nodeMajor >= MINIMUM_NODE_MAJOR)) {
    reasons.push('NODE_VERSION_UNSUPPORTED');
  }

  const explicitBrowser = typeof env.SANGFOR_CHROMIUM_PATH === 'string' && env.SANGFOR_CHROMIUM_PATH.trim() !== '';

  if (host.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    warnings.push('NO_DISPLAY_INTERACTIVE_LOGIN_REQUIRES_DISPLAY');
  }

  const steps = [
    step({
      id: 'corepack',
      title: 'Enable the pinned package manager',
      command: 'corepack enable',
      detail: 'Activates the pnpm version pinned by package.json packageManager.',
      readOnly,
    }),
    step({
      id: 'install_dependencies',
      title: 'Install workspace dependencies from the committed lockfile',
      command: readOnly
        ? 'pnpm install --frozen-lockfile --offline --dry-run'
        : 'pnpm install --frozen-lockfile',
      detail: 'pnpm is the only supported package manager; the npm lockfile is not maintained.',
      readOnly,
    }),
    step({
      id: 'install_browser',
      title: explicitBrowser
        ? 'Use the operator-provided browser executable'
        : 'Install the Playwright-managed Chromium build',
      command: explicitBrowser
        ? 'test -x "$SANGFOR_CHROMIUM_PATH"'
        : 'pnpm exec playwright install --with-deps chromium',
      detail: explicitBrowser
        ? 'SANGFOR_CHROMIUM_PATH is set, so the managed download is skipped and the provided executable is verified instead.'
        : 'Downloads the browser revision matching the repository Playwright dependency.',
      readOnly,
      skipped: explicitBrowser,
    }),
    step({
      id: 'preflight',
      title: 'Evaluate endpoint readiness fail-closed',
      command: 'node scripts/jm-endpoint-preflight.mjs --json',
      detail: 'Reports READY only when runtime, browser, CDP registry, and execution gates all pass.',
      readOnly: true,
    }),
    step({
      id: 'mock_smoke',
      title: 'Prove the browser port end-to-end against the local mock console',
      command:
        'pnpm run dev:mock-console  # then: pnpm exec tsx scripts/test-browser-port.ts --scenario local-readback --base-url http://127.0.0.1:3400/hci',
      detail: 'Loopback-only rehearsal: read, approved reversible mutation, independent read-back, restore.',
      readOnly,
    }),
  ];

  return {
    mode,
    readOnly,
    supported: reasons.length === 0,
    requiresCustomerAccess: false,
    host: { platform: host.platform, arch: host.arch, nodeMajor: host.nodeMajor },
    reasons,
    warnings,
    steps,
    summary:
      reasons.length === 0
        ? `JM_ENDPOINT_INSTALL_PLAN_OK: ${steps.length} step(s), mode=${mode}`
        : `JM_ENDPOINT_INSTALL_UNSUPPORTED: ${reasons.join(', ')}`,
  };
}
