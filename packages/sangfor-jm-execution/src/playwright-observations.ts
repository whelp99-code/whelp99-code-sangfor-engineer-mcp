import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Page } from 'playwright';
import type {
  BrowserExecutionResult,
  JsonValue,
} from '../../sangfor-browser-contracts/src/index.js';

export function maskBrowserObservationText(
  text: string,
  localSecretValues: readonly string[] = [],
): string {
  let masked = text;
  const secrets = [...new Set(localSecretValues.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) masked = masked.split(secret).join('***');
  masked = masked.replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 ***');
  masked = masked.replace(
    /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|session(?:id)?)((?:\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1$2***',
  );
  return masked.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '***',
  );
}

function maskObservationUrl(url: string, localSecretValues: readonly string[]): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    for (const key of parsed.searchParams.keys()) {
      if (/password|passwd|secret|token|api[_-]?key|authorization|cookie|session(?:id)?/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return maskBrowserObservationText(parsed.toString(), localSecretValues);
  } catch {
    return maskBrowserObservationText(url, localSecretValues);
  }
}

export async function browserObservations(
  page: Page,
  credentials?: { username: string; password: string },
): Promise<Record<string, JsonValue>> {
  const raw = await page.evaluate(() => ({
    title: document.title,
    url: window.location.href,
    text: document.body.innerText.slice(0, 4000),
  }));
  const localSecretValues = credentials
    ? [credentials.username, credentials.password]
    : [];
  return {
    title: maskBrowserObservationText(raw.title, localSecretValues),
    url: maskObservationUrl(raw.url, localSecretValues),
    text: maskBrowserObservationText(raw.text, localSecretValues),
  };
}

export function browserEvidenceRef(path: string, artifactRef: string) {
  const bytes = readFileSync(path);
  return {
    artifactRef,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'image/png' as const,
    size: statSync(path).size,
  };
}

export function browserResult(
  requestId: string,
  overrides: Partial<BrowserExecutionResult>,
): BrowserExecutionResult {
  return {
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'PASS',
    mutationAttempted: false,
    evidence: [],
    ...overrides,
  };
}

export function browserOrigin(url: string): string | undefined {
  if (url === 'about:blank') return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function assertPageOrigin(page: Page, expectedOrigin: string, phase: string): void {
  const actualOrigin = browserOrigin(page.url());
  if (actualOrigin !== expectedOrigin) {
    throw new Error(
      `Page origin changed ${phase}: ${actualOrigin ?? '<invalid>'} is outside origin ${expectedOrigin}.`,
    );
  }
}
