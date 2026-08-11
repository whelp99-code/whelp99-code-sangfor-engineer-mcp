import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  isReadOnlyEvidenceLabel,
} from '../../sangfor-browser-contracts/src/index.js';
import {
  loginWithSessionCredentials,
  performConsoleAction,
  uniqueNavigationTarget,
  verifyConsole,
} from './playwright-actions.js';
import {
  assertPageOrigin,
  browserEvidenceRef,
  browserObservations,
  browserOrigin,
  browserResult,
} from './playwright-observations.js';
import {
  assertOwnedCdpBinding,
  loopbackCdpEndpoint,
  resolvePlaywrightLaunchOptions,
  shouldIgnoreHttpsErrors,
} from './playwright-options.js';
import type {
  JmArtifactMaterializer,
  JmBrowserDriver,
  JmBrowserRuntimeLifecycle,
  LocalJmSession,
} from './types.js';

export {
  loginWithSessionCredentials,
  prepareConsoleAction,
  shouldDispatchConsoleAction,
} from './playwright-actions.js';
export { maskBrowserObservationText } from './playwright-observations.js';
export {
  assertOwnedCdpBinding,
  loopbackCdpEndpoint,
  resolvePlaywrightLaunchOptions,
  shouldIgnoreHttpsErrors,
} from './playwright-options.js';

interface BrowserHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface PlaywrightJmBrowserDriverOptions {
  evidenceDir: string;
}

export function createPlaywrightJmBrowserDriver(
  options: PlaywrightJmBrowserDriverOptions,
): JmBrowserDriver & JmArtifactMaterializer & JmBrowserRuntimeLifecycle {
  mkdirSync(options.evidenceDir, { recursive: true });
  const handles = new Map<string, BrowserHandle>();

  async function acquire(session: LocalJmSession): Promise<BrowserHandle> {
    const existing = handles.get(session.sessionId);
    if (existing) return existing;

    let browser: Browser;
    const borrowed = session.cdpPort !== undefined;
    if (borrowed) {
      assertOwnedCdpBinding(session);
      browser = await chromium.connectOverCDP(loopbackCdpEndpoint(session.cdpPort));
    } else {
      browser = await chromium.launch(resolvePlaywrightLaunchOptions({
        headless: session.headless ?? true,
        sessionChromiumPath: session.chromiumPath,
        configuredChromiumPath: process.env.SANGFOR_CHROMIUM_PATH,
      }));
    }
    try {
      let context: BrowserContext;
      let page: Page;
      if (borrowed) {
        const contexts = browser.contexts();
        if (contexts.length !== 1 || contexts[0] === undefined) {
          throw new Error(`Borrowed browser requires exactly one context; found ${contexts.length}.`);
        }
        context = contexts[0];
        const candidates = context.pages().filter((candidate) => {
          const candidateOrigin = browserOrigin(candidate.url());
          return candidateOrigin === undefined || candidateOrigin === session.origin;
        });
        if (candidates.length !== 1 || candidates[0] === undefined) {
          throw new Error(
            `Borrowed browser has ambiguous intended pages; expected exactly one and found ${candidates.length}.`,
          );
        }
        page = candidates[0];
      } else {
        context = await browser.newContext({
          ignoreHTTPSErrors: shouldIgnoreHttpsErrors(
            session.mode,
            session.targetUrl ?? session.origin,
          ),
        });
        page = await context.newPage();
      }
      const targetUrl = session.targetUrl ?? session.origin;
      if (page.url() === 'about:blank') {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }
      assertPageOrigin(page, session.origin, 'during acquisition');
      if (session.credentials) {
        await loginWithSessionCredentials(page, session.credentials, session.origin);
        assertPageOrigin(page, session.origin, 'after login');
      }
      const handle = { browser, context, page };
      handles.set(session.sessionId, handle);
      return handle;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  function artifactIdentity(sessionId: string, requestId: string) {
    const id = createHash('sha256')
      .update(sessionId)
      .update('\0')
      .update(requestId)
      .digest('hex');
    return {
      artifactRef: `artifact://jm/${id}`,
      path: join(options.evidenceDir, `${id}.png`),
    };
  }

  async function capture(page: Page, sessionId: string, requestId: string) {
    const artifact = artifactIdentity(sessionId, requestId);
    await page.screenshot({ path: artifact.path, fullPage: true });
    return browserEvidenceRef(artifact.path, artifact.artifactRef);
  }

  return {
    async execute(session, request) {
      if (
        request.operation.kind === 'capture_structure'
        || request.operation.kind === 'extract_authenticated_knowledge'
      ) {
        return browserResult(request.requestId, {
          status: 'UNSUPPORTED',
          error: {
            code: 'JM_BROWSER_OPERATION_UNSUPPORTED',
            message: `JM local browser execution does not support ${request.operation.kind}.`,
          },
        });
      }
      const { page } = await acquire(session);
      if (new URL(page.url()).origin !== request.origin) {
        throw new Error('Page origin changed before execution.');
      }

      if (request.operation.kind === 'perform_console_action') {
        await performConsoleAction(page, request);
        assertPageOrigin(page, request.origin, 'after console action');
        const evidence = [await capture(page, session.sessionId, request.requestId)];
        const mutated = request.operation.action.dryRun === false;
        return browserResult(request.requestId, {
          status: mutated ? 'INDETERMINATE' : 'PASS',
          mutationAttempted: mutated,
          readBack: {
            status: mutated ? 'INDETERMINATE' : 'PASS',
            observations: await browserObservations(page, session.credentials),
          },
          evidence,
        });
      }
      if (request.operation.kind === 'verify_console') {
        const passed = await verifyConsole(page, request);
        assertPageOrigin(page, request.origin, 'after verification');
        return browserResult(request.requestId, {
          status: passed ? 'PASS' : 'FAIL',
          readBack: {
            status: passed ? 'PASS' : 'FAIL',
            observations: await browserObservations(page, session.credentials),
          },
        });
      }
      if (request.operation.kind === 'capture_console_evidence') {
        for (const step of request.operation.menuPath) {
          if (
            !isReadOnlyEvidenceLabel(step.menu)
            || (step.submenu !== undefined && !isReadOnlyEvidenceLabel(step.submenu))
          ) {
            return browserResult(request.requestId, {
              status: 'REFUSED',
              error: {
                code: 'JM_BROWSER_DESTRUCTIVE_EVIDENCE_LABEL',
                message: 'Evidence capture refused a destructive navigation label.',
              },
            });
          }
          await (await uniqueNavigationTarget(page, step.menu)).click();
          if (step.submenu) {
            await (await uniqueNavigationTarget(page, step.submenu)).click();
          }
          assertPageOrigin(page, request.origin, 'after evidence navigation');
        }
        return browserResult(request.requestId, {
          readBack: { status: 'PASS' },
          evidence: [await capture(page, session.sessionId, request.requestId)],
        });
      }
      return browserResult(request.requestId, {
        readBack: { status: 'PASS' },
        observations: await browserObservations(page, session.credentials),
      });
    },
    async closeSession(session) {
      const handle = handles.get(session.sessionId);
      if (!handle) return;
      handles.delete(session.sessionId);
      await handle.browser.close();
    },
    async closeAll() {
      const active = [...handles.values()];
      handles.clear();
      await Promise.all(active.map(async (handle) => handle.browser.close()));
    },
    async materializeArtifact(artifactRef, destinationPath) {
      const match = /^artifact:\/\/jm\/([a-f0-9]{64})$/.exec(artifactRef);
      if (!match?.[1]) {
        throw new Error('JM_ARTIFACT_REF_INVALID: opaque JM artifact reference required.');
      }
      const sourcePath = join(options.evidenceDir, `${match[1]}.png`);
      if (!existsSync(sourcePath)) {
        throw new Error('JM_ARTIFACT_NOT_FOUND: artifact is unavailable.');
      }
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    },
  };
}
