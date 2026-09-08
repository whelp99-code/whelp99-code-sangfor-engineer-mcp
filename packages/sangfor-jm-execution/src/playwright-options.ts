import { isAbsolute } from 'node:path';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import { parseOwnedCdpProfilesEnvironment } from './runtime-boundaries.js';
import type { LocalJmMode, LocalJmSession } from './types.js';

export function resolvePlaywrightLaunchOptions(input: {
  headless: boolean;
  sessionChromiumPath?: string;
  configuredChromiumPath?: string;
}): { headless: boolean; executablePath?: string } {
  const executablePath = input.sessionChromiumPath ?? input.configuredChromiumPath;
  if (!executablePath) return { headless: input.headless };
  if (!isAbsolute(executablePath)) {
    throw new Error('JM browser executable path must be absolute.');
  }
  return { headless: input.headless, executablePath };
}

export function loopbackCdpEndpoint(cdpPort: unknown): string {
  if (
    typeof cdpPort !== 'number'
    || !Number.isSafeInteger(cdpPort)
    || cdpPort < 1
    || cdpPort > 65_535
  ) {
    throw new Error('CDP_PORT_INVALID: expected an integer from 1 through 65535.');
  }
  return `http://127.0.0.1:${cdpPort}`;
}

export function shouldIgnoreHttpsErrors(
  mode: LocalJmMode,
  targetUrl: string | undefined,
): boolean {
  return (mode === 'mock' || mode === 'lab' || mode === 'poc')
    && isLoopbackBrowserTarget(targetUrl);
}

export function assertOwnedCdpBinding(session: LocalJmSession): void {
  if (session.cdpPort === undefined) return;
  const raw = process.env.SANGFOR_JM_CDP_PROFILES_JSON;
  if (raw === undefined) {
    throw new Error(
      'CDP_PROFILE_REQUIRED: borrowed CDP ports require SANGFOR_JM_CDP_PROFILES_JSON.',
    );
  }
  const profiles = parseOwnedCdpProfilesEnvironment(raw);
  const owned = profiles.some((candidate) => {
    if (candidate.cdpPort !== session.cdpPort) return false;
    try {
      return new URL(candidate.expectedOrigin).origin === session.origin;
    } catch {
      return false;
    }
  });
  if (!owned) {
    throw new Error(
      'CDP_PROFILE_MISMATCH: no trusted CDP profile owns this port and origin.',
    );
  }
}
