import { isAbsolute } from 'node:path';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import type { LocalJmMode, LocalJmSession } from './types.js';

interface OwnedCdpProfile {
  profileRef: string;
  cdpPort: number;
  expectedOrigin: string;
}

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
  let profiles: unknown;
  try {
    profiles = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('CDP_PROFILE_INVALID: trusted CDP profile registry is corrupt.');
  }
  if (!Array.isArray(profiles)) {
    throw new Error(
      'CDP_PROFILE_REQUIRED: borrowed CDP ports require SANGFOR_JM_CDP_PROFILES_JSON.',
    );
  }
  const owned = profiles.some((candidate): candidate is OwnedCdpProfile => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.profileRef !== 'string'
      || !value.profileRef
      || value.cdpPort !== session.cdpPort
      || typeof value.expectedOrigin !== 'string'
    ) return false;
    try {
      return new URL(value.expectedOrigin).origin === session.origin;
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
