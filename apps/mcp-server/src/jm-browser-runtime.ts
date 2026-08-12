import { join } from 'node:path';
import { getOperatorSession } from '../../../packages/sangfor-operator/src/index.js';
import {
  createInProcessJobExecutionPort,
  createJmObserverTransport,
  createLocalJmExecutionPort,
  createPlaywrightJmBrowserDriver,
} from '../../../packages/sangfor-jm-execution/src/index.js';

export function createDefaultJmBrowserRuntime() {
  const driver = createPlaywrightJmBrowserDriver({
    evidenceDir: join(process.cwd(), 'data', 'evidence', 'jm-browser-runtime'),
  });
  const executionPort = createLocalJmExecutionPort({
    resolveSession(sessionId) {
      const session = getOperatorSession(sessionId);
      if (!session.targetUrl) return undefined;
      return {
        sessionId: session.id,
        origin: new URL(session.targetUrl).origin,
        targetUrl: session.targetUrl,
        mode: session.mode,
        ...(session.browser?.useLocalBrowser && session.cdpPort !== undefined
          ? { cdpPort: session.cdpPort }
          : {}),
        ...(process.env.SANGFOR_CHROMIUM_PATH
          ? { chromiumPath: process.env.SANGFOR_CHROMIUM_PATH }
          : {}),
        headless: session.browser?.headless
          ?? process.env.SANGFOR_BROWSER_HEADLESS !== 'false',
        ...(session.credentials ? { credentials: session.credentials } : {}),
      };
    },
    driver,
  });
  return {
    executionPort: createInProcessJobExecutionPort(executionPort, {
      tenantId: 'mcp-local',
      projectId: 'mcp-local',
      capability: 'in-process-opaque',
    }),
    observerTransport: createJmObserverTransport(),
    materializeArtifact: driver.materializeArtifact,
    dispose: driver.closeAll,
  };
}
