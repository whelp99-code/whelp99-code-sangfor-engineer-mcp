import type { BrowserExecutionPort } from '../../../packages/sangfor-browser-contracts/src/index.js';
import { startOperatorSession, closeOperatorSession } from '../../../packages/sangfor-operator/src/index.js';
import { captureProductScreenshots, resolveProductScreenshotTargetUrl } from '../../../packages/sangfor-screenshot/src/index.js';
import { LearningStrategyService, assertSafeLearningInput } from '../../../packages/sangfor-learning-strategy/src/index.js';
import { ObserverSessionManager, type ObserverProfile, type ObserverTransport } from '../../../packages/sangfor-observer/src/index.js';
import { configureIagOrchestratorToolService } from './iag-orchestrator-tools.js';

let learningService: LearningStrategyService | undefined;
export const currentLearningService = (): LearningStrategyService => learningService ??= new LearningStrategyService();
export const pendingLearningCaptures = new Map<string, { sessionHandle: string; durationMs?: number; firmwareVersion?: string }>();
let observerManagerCache: { source: string; manager: ObserverSessionManager } | undefined;
let browserExecutionPort: BrowserExecutionPort | undefined;
let observerTransport: ObserverTransport | undefined;
let browserArtifactMaterializer:
  | ((artifactRef: string, destinationPath: string) => Promise<void>)
  | undefined;
let browserRuntimeDispose: (() => Promise<void>) | undefined;

export function configureJmBrowserRuntime(deps: {
  executionPort: BrowserExecutionPort;
  observerTransport: ObserverTransport;
  materializeArtifact?: (artifactRef: string, destinationPath: string) => Promise<void>;
  dispose?: () => Promise<void>;
}): void {
  browserExecutionPort = deps.executionPort;
  observerTransport = deps.observerTransport;
  browserArtifactMaterializer = deps.materializeArtifact;
  browserRuntimeDispose = deps.dispose;
  observerManagerCache = undefined;
  configureIagOrchestratorToolService(undefined);
}

export function isJmBrowserRuntimeConfigured(): boolean {
  return browserExecutionPort !== undefined && observerTransport !== undefined;
}

export function disposeJmBrowserRuntime(): Promise<void> {
  return browserRuntimeDispose?.() ?? Promise.resolve();
}

export function requiredBrowserExecutionPort(): BrowserExecutionPort {
  if (!browserExecutionPort) throw new Error('JM_BROWSER_RUNTIME_REQUIRED: browser execution port is not configured.');
  return browserExecutionPort;
}

export function requiredObserverTransport(): ObserverTransport {
  if (!observerTransport) throw new Error('JM_BROWSER_RUNTIME_REQUIRED: observer transport is not configured.');
  return observerTransport;
}

export function requiredBrowserArtifactMaterializer() {
  if (!browserArtifactMaterializer) {
    throw new Error('JM_BROWSER_RUNTIME_REQUIRED: artifact materializer is not configured.');
  }
  return browserArtifactMaterializer;
}

type ProductScreenshotToolInput = {
  product: 'EPP' | 'IAG' | 'CC';
  targetUrl?: string;
  username?: string;
  password?: string;
  outputDir?: string;
  cdpPort?: number;
  headless?: boolean;
  dryRun?: boolean;
  menus?: Array<{ menu: string; submenu?: string }>;
};

export async function captureProductScreenshotsWithJm(
  args: ProductScreenshotToolInput,
) {
  if (args.dryRun) {
    return captureProductScreenshots({
      product: args.product,
      targetUrl: args.targetUrl,
      outputDir: args.outputDir,
      menus: args.menus,
      dryRun: true,
    });
  }
  const targetUrl = resolveProductScreenshotTargetUrl(args.product, args.targetUrl);
  const session = startOperatorSession({
    product: args.product,
    mode: 'customer_readonly',
    targetUrl,
    browser: {
      ...(args.cdpPort !== undefined
        ? { cdpPort: args.cdpPort, useLocalBrowser: true }
        : {}),
      ...(args.headless !== undefined ? { headless: args.headless } : {}),
    },
    credentials: args.username && args.password
      ? { username: args.username, password: args.password }
      : undefined,
  });
  const executionPort = requiredBrowserExecutionPort();
  try {
    return await captureProductScreenshots({
      product: args.product,
      targetUrl,
      outputDir: args.outputDir,
      menus: args.menus,
      sessionId: session.id,
      executionPort,
      materializeArtifact: requiredBrowserArtifactMaterializer(),
    });
  } finally {
    await closeOperatorSession(session.id, executionPort);
  }
}

export function learningArgs(args: unknown, keys: readonly string[]): Record<string, any> {
  assertSafeLearningInput(args, keys);
  return args as Record<string, any>;
}

export function observerManager(): ObserverSessionManager {
  const source = process.env.SANGFOR_OBSERVER_PROFILES_JSON;
  if (!source) throw new Error('OBSERVER_PROFILES_UNAVAILABLE: SANGFOR_OBSERVER_PROFILES_JSON is required.');
  if (observerManagerCache?.source === source) return observerManagerCache.manager;
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error('OBSERVER_PROFILES_INVALID: profiles must be JSON.'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('OBSERVER_PROFILES_INVALID: a non-empty profile array is required.');
  for (const profile of parsed) assertSafeLearningInput(profile, ['product', 'expectedOrigin', 'cdpPort', 'firmwareTruthId', 'deviceScope']);
  const manager = new ObserverSessionManager(parsed as ObserverProfile[], requiredObserverTransport());
  observerManagerCache = { source, manager };
  return manager;
}

// ─── HCI/SCP OpenAPI wiring (doc-contract; verified on a real device in M4) ────
