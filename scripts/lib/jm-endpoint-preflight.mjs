/**
 * JM endpoint preflight — fail-closed readiness evaluation for the client-side
 * browser execution edge.
 *
 * Pure evaluation: all host interaction arrives through injected probes so the
 * same logic is testable without a browser, a console, or customer network
 * access. NEVER reports READY on partial evidence, and never echoes a secret
 * value into the report.
 */

const MINIMUM_NODE_MAJOR = 20;

/** Hosts that may expose a Chrome DevTools Protocol endpoint. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(hostname);
}

/** A mutation target is trusted only when it resolves to a loopback origin. */
export function isLoopbackTarget(rawUrl) {
  try {
    return isLoopbackHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** An exact origin has no path, query, fragment, or credentials. */
function isExactOrigin(rawOrigin) {
  let parsed;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  return parsed.pathname === '/' && !rawOrigin.replace(parsed.origin, '').startsWith('/');
}

function isSafePort(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 65_536;
}

function parseCdpProfiles(raw) {
  if (raw === undefined || raw.trim() === '') return { state: 'absent', profiles: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', profiles: [] };
  }
  if (!Array.isArray(parsed)) return { state: 'corrupt', profiles: [] };
  return { state: 'present', profiles: parsed };
}

function check(id, status, detail) {
  return { id, status, detail };
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {object} [input.probes]
 * @returns {{ready: boolean, exitCode: number, reasons: string[], checks: Array<{id: string, status: string, detail: string}>, summary: string}}
 */
export function evaluateJmEndpointPreflight(input) {
  const env = input?.env ?? {};
  const probes = input?.probes ?? {};
  const executableExists = probes.executableExists ?? (() => false);
  const nodeMajor = probes.nodeMajor ?? (() => 0);

  const checks = [];
  const reasons = [];

  const fail = (id, code, detail) => {
    checks.push(check(id, 'FAIL', detail));
    if (!reasons.includes(code)) reasons.push(code);
  };

  // 1. Node runtime.
  const major = nodeMajor();
  if (major >= MINIMUM_NODE_MAJOR) {
    checks.push(check('node_runtime', 'PASS', `node major ${major} >= ${MINIMUM_NODE_MAJOR}`));
  } else {
    fail(
      'node_runtime',
      'NODE_VERSION_UNSUPPORTED',
      `node major ${major} is below the required ${MINIMUM_NODE_MAJOR}`,
    );
  }

  // 2. Browser executable.
  const chromiumPath = env.SANGFOR_CHROMIUM_PATH;
  if (chromiumPath === undefined || chromiumPath.trim() === '') {
    fail(
      'browser_executable',
      'BROWSER_EXECUTABLE_UNSET',
      'SANGFOR_CHROMIUM_PATH is not set; JM cannot resolve a browser executable',
    );
  } else if (!executableExists(chromiumPath)) {
    fail(
      'browser_executable',
      'BROWSER_EXECUTABLE_MISSING',
      `configured browser executable is not present or not executable: ${chromiumPath}`,
    );
  } else {
    checks.push(check('browser_executable', 'PASS', `resolved browser executable: ${chromiumPath}`));
  }

  // 3. Borrowed-CDP profile registry.
  const registry = parseCdpProfiles(env.SANGFOR_JM_CDP_PROFILES_JSON);
  if (registry.state === 'corrupt') {
    fail(
      'cdp_profiles',
      'CDP_PROFILE_REGISTRY_CORRUPT',
      'SANGFOR_JM_CDP_PROFILES_JSON is not a JSON array; borrowed CDP attach must fail closed',
    );
  } else if (registry.state === 'absent') {
    checks.push(
      check(
        'cdp_profiles',
        'PASS',
        'no borrowed CDP profile registered; JM will only use managed browsers',
      ),
    );
  } else {
    const problems = [];
    for (const [index, profile] of registry.profiles.entries()) {
      const label = profile?.profileRef ?? `#${index}`;
      if (typeof profile?.profileRef !== 'string' || profile.profileRef.trim() === '') {
        problems.push(['CDP_PROFILE_REGISTRY_CORRUPT', `profile ${label} has no profileRef`]);
        continue;
      }
      if (!isSafePort(profile?.cdpPort)) {
        problems.push(['CDP_PROFILE_PORT_INVALID', `profile ${label} has an invalid cdpPort`]);
      }
      const host = profile?.cdpHost ?? '127.0.0.1';
      if (!isLoopbackHostname(String(host))) {
        problems.push([
          'CDP_BIND_NOT_LOOPBACK',
          `profile ${label} binds CDP to non-loopback host ${host}`,
        ]);
      }
      if (typeof profile?.expectedOrigin !== 'string' || !isExactOrigin(profile.expectedOrigin)) {
        problems.push([
          'CDP_PROFILE_ORIGIN_INVALID',
          `profile ${label} expectedOrigin must be an exact scheme://host[:port] origin`,
        ]);
      }
    }
    if (problems.length > 0) {
      for (const [code, detail] of problems) fail('cdp_profiles', code, detail);
    } else {
      checks.push(
        check(
          'cdp_profiles',
          'PASS',
          `${registry.profiles.length} borrowed CDP profile(s) registered with loopback bind and exact origin`,
        ),
      );
    }
  }

  // 4. Execution gates. Read-only by default; every opt-in adds requirements.
  const realExecution = env.SANGFOR_ALLOW_REAL_EXECUTION === 'true';
  const productionExecution = env.SANGFOR_ALLOW_PRODUCTION_EXECUTION === 'true';
  const approvalSecret = env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  const consoleUrl = env.SANGFOR_CONSOLE_URL;

  if (!realExecution) {
    checks.push(
      check('execution_gates', 'PASS', 'read-only default: SANGFOR_ALLOW_REAL_EXECUTION is not enabled'),
    );
  } else {
    if (approvalSecret === undefined || approvalSecret.trim() === '') {
      fail(
        'execution_gates',
        'APPROVAL_SECRET_MISSING',
        'SANGFOR_ALLOW_REAL_EXECUTION is enabled without SANGFOR_OPERATOR_APPROVAL_SECRET',
      );
    } else {
      checks.push(
        check('execution_gates', 'PASS', 'real execution enabled with a server-side approval secret present'),
      );
    }

    const targetKnown = typeof consoleUrl === 'string' && consoleUrl.trim() !== '';
    const loopbackTarget = targetKnown && isLoopbackTarget(consoleUrl);
    if (targetKnown && !loopbackTarget && !productionExecution) {
      fail(
        'production_gate',
        'PRODUCTION_OPT_IN_REQUIRED',
        'non-loopback mutation target requires SANGFOR_ALLOW_PRODUCTION_EXECUTION=true',
      );
    } else if (targetKnown) {
      checks.push(
        check(
          'production_gate',
          'PASS',
          loopbackTarget
            ? 'loopback mutation target does not require the production opt-in'
            : 'non-loopback target is covered by SANGFOR_ALLOW_PRODUCTION_EXECUTION',
        ),
      );
    }
  }

  const ready = reasons.length === 0;
  return {
    ready,
    exitCode: ready ? 0 : 1,
    reasons,
    checks,
    summary: ready
      ? 'JM_ENDPOINT_PREFLIGHT_READY'
      : `JM_ENDPOINT_PREFLIGHT_NOT_READY: ${reasons.join(', ')}`,
  };
}
