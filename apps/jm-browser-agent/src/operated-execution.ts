import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  createLocalJmExecutionPort,
  createPlaywrightJmBrowserDriver,
} from '@sangfor/jm-execution';
import {
  EXECUTION_PREFLIGHT_REFUSALS,
  type ExecutionPreflight,
  type JmAgentConfig,
  type JmExecutionPort,
} from '../../../packages/sangfor-jm-agent/src/index.js';

/**
 * Constructs the real operated browser execution port from approved operated
 * configuration. This is the only execution factory production can reach.
 */
export function createOperatedExecutionPort(config: JmAgentConfig): JmExecutionPort {
  const driver = createPlaywrightJmBrowserDriver({
    evidenceDir: join(config.journalRoot, 'evidence'),
  });
  const port = createLocalJmExecutionPort({
    resolveSession: (sessionId) => (sessionId === config.browserSessionId
      ? {
        sessionId: config.browserSessionId,
        origin: config.allowedOrigin,
        targetUrl: config.allowedOrigin,
        mode: 'customer_readonly' as const,
        profileRef: config.browserProfileRef,
        chromiumPath: config.browserChromiumPath,
        headless: true,
      }
      : undefined),
    driver,
  });
  return {
    startupPreflight: (bind) => operatedStartupPreflight(config, bind),
    readinessPreflight: () => operatedReadinessPreflight(config),
    execute: (request, context) => port.execute(request, context),
    close: () => driver.closeAll(),
  };
}

/**
 * Startup phase: everything readiness checks, PLUS a real bind of the address
 * the listener is about to take. If the bind cannot be obtained there is no
 * point creating a listener, so the caller refuses to start.
 */
export async function operatedStartupPreflight(
  config: JmAgentConfig,
  bind: { readonly host: string; readonly port: number },
): Promise<ExecutionPreflight> {
  const ongoing = operatedReadinessPreflight(config);
  if (!ongoing.ok) return ongoing;
  return await probeLoopbackBind(bind.host, bind.port)
    ? { ok: true }
    : { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.PORT_UNAVAILABLE };
}

/**
 * Ongoing phase: the executable, the profile and the driver seam must still be
 * usable. It deliberately does NOT bind the service port, which the running
 * listener already holds.
 */
export function operatedReadinessPreflight(config: JmAgentConfig): ExecutionPreflight {
  if (!realRegularFile(config.browserChromiumPath)) {
    return { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.CHROMIUM_MISSING };
  }
  try {
    accessSync(config.browserChromiumPath, constants.X_OK);
  } catch {
    return { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.CHROMIUM_NOT_EXECUTABLE };
  }
  const profileRoot = config.browserProfileRoot;
  let stats;
  try {
    stats = lstatSync(profileRoot);
  } catch {
    return { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.PROFILE_MISSING };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(profileRoot) !== profileRoot) {
    return { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.PROFILE_INSECURE };
  }
  if ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()) {
    return { ok: false, reason: EXECUTION_PREFLIGHT_REFUSALS.PROFILE_INSECURE };
  }
  return { ok: true };
}

/**
 * Proves the exact address the listener will take can actually be bound. Port 0
 * asks the kernel for any ephemeral port, which is the right probe when the
 * service itself will bind ephemerally.
 */
export function probeLoopbackBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

function realRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && stats.isFile() && realpathSync(path) === path;
  } catch {
    return false;
  }
}
