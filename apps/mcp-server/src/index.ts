import readline from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { analyzeProject, generateConfigPlan, generateConfigPlanAsync, validateConfigPlan } from '../../../packages/sangfor-planner/src/index.js';
import { searchManuals, getManualSection } from '../../../packages/sangfor-knowledge/src/index.js';
import { searchWiki, proposeWikiUpdate, approveWikiUpdate, applyWikiUpdate, applyObsidianWikiUpdate, applyGitHubWikiUpdate, listKnowledgeCards, upsertKnowledgeCard } from '../../../packages/sangfor-wiki/src/index.js';
import { requiresApprovalForText, canonicalizeApprovalPayload, verifyDomainApprovalSignature, FileSingleUseNonceStore } from '../../../packages/sangfor-approval/src/index.js';
import { authorizeHciMutation, startOperatorSession, readConsoleState, executeConsoleAction, readLiveConsoleState, executeLiveConsoleAction, closeOperatorSession } from '../../../packages/sangfor-operator/src/index.js';
import type { BrowserExecutionPort } from '../../../packages/sangfor-browser-contracts/src/index.js';
import { verifyResult } from '../../../packages/sangfor-verifier/src/index.js';
import { generateEvidenceReport, buildChangeRunReport, listChangeRunIds, isSafeRunId } from '../../../packages/sangfor-evidence/src/index.js';
import { submitFeedback, extractLesson } from '../../../packages/sangfor-feedback/src/index.js';
import { createEvalCaseFromFeedback, runPlannerEval } from '../../../packages/sangfor-evals/src/index.js';
import { PRODUCTS, type ProductCode } from '../../../packages/shared/src/index.js';
import { findUnapprovedDrift, getDiff as getChronicleDiff, getHead as getChronicleHead, listSnapshots as listChronicleSnapshots } from '../../../packages/sangfor-chronicle/src/index.js';
import { queryDevices, computeTier, autonomyAllowed, type TierThresholds, type ScorecardMetrics } from '../../../packages/sangfor-scorecard/src/index.js';
import { verifyReportChain } from '../../../packages/sangfor-engineer-report/src/index.js';
import { ingestDocument, ragSearch, exportRagIndexSummary, omitVectorFromHit, getRagSearchDiagnostics } from '../../../packages/sangfor-rag/src/index.js';
import { createFineTuneDataset, createFineTuneJobSpec, validateFineTuneDataset } from '../../../packages/sangfor-finetune/src/index.js';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { runLearnSourcesPipeline } from '../../../packages/sangfor-collector/src/learn-pipeline.js';
import { buildLoopStatus } from '../../../packages/sangfor-loop/src/index.js';
import { persistConfigPlan, persistFeedbackEvent, storeHealthCheck } from '../../../packages/sangfor-store/src/index.js';
import {
  analyzeCustomerRequirements,
  applyApprovedProductChange,
  collectProductConfig,
  discoverProductConsole,
  dryRunProductChange,
  generateExcelBasedChangePlan,
  generateProductChangePlan,
  importExcelRequirementList,
  mapRequirementsToProducts,
  verifyProductChange,
  buildSettingGuideDocx,
  buildOperationsGuideDocx,
  buildComprehensiveSettingGuideDocx,
  buildComprehensiveOperationsGuideDocx,
} from '../../../packages/sangfor-product-adapters/src/index.js';
import { buildSettingGuidePptx, buildOperationsGuidePptx } from '../../../packages/sangfor-pptx/src/index.js';
import { isOfficeCliAvailable, validateOfficeDocument } from '../../../packages/sangfor-office/src/index.js';
import { buildEvidencePackage, type EvidencePackageItem } from '../../../packages/sangfor-evidence/src/evidence-package.js';
import { captureProductScreenshots, captureConsoleEvidence, verifyCaptureLedger, resolveConfinedOutputDir, resolveProductScreenshotTargetUrl, buildCaptureRelativeDir, DEFAULT_CONSOLE_CDP_PORT, formatDateStamp as formatCaptureDateStamp } from '../../../packages/sangfor-screenshot/src/index.js';
import { loadSpec, evaluateSpec, renderAdvisoryReport, renderAdvisoryReportDocx, listSpecCoverage, type IntendedSpec } from '../../../packages/sangfor-spec/src/index.js';
import { getCapabilitySafety, listCapabilitySafety, loadMaturityPolicy } from '../../../packages/sangfor-safety/src/index.js';
import { buildRepoCoverageContext, computeReplacementCoverage, loadWorkAtomCatalog } from '../../../packages/sangfor-competency/src/index.js';
import { suggestRca } from '../../../packages/sangfor-rca/src/index.js';
import { recommendSizing, type SizingInput } from '../../../packages/sangfor-sizing/src/index.js';
import { createPmStore } from '../../../packages/sangfor-pm/src/index.js';
import { checkVersionRequirement, loadVersionRequirements } from '../../../packages/sangfor-version/src/index.js';
import { generateIntegrationGuide, listIntegrationTypes } from '../../../packages/sangfor-integration/src/index.js';
import { resolveProductionLocalWriteAuthority, resolveRepoData, resolveEngagementScopedData, activeEngagementId, nowId, normalizeProduct, paginate, appendJsonl, writeFileAtomicSync } from '../../../packages/shared/src/index.js';
import { mapEppPoolToConfigState, mapCcPoolToConfigState } from '../../../packages/sangfor-config-state/src/index.js';
import { fortios_policy_baseline, fortios_system_health_baseline, fortios_policy_audit_baseline } from '../../../packages/fortios-spec/src/index.js';
import { mapFortiOSConfigState, mapFortiOSSystemHealth, mapFortiOSPolicyAudit } from '../../../packages/fortios-client/src/index.js';
import { cisco_interface_baseline, cisco_system_health_baseline, cisco_policy_audit_baseline } from '../../../packages/cisco-spec/src/index.js';
import { mapCiscoConfigState, mapCiscoSystemHealth, mapCiscoPolicyAudit } from '../../../packages/cisco-client/src/index.js';
import { randomBytes } from 'node:crypto';
import {
  HciClient, KeystoneV2TokenProvider, HCI_AUTH_CONTRACT_STATUS,
  collectInventory, readBackVolume, applyCreateVolume, deleteVolume, getVolume,
  AuditLedger, assertLocalAuditAuthorityAllowed, validateCreateVolumeInput,
  summarizeHciHealth, renderHciHealthReport,
  httpJson,
} from '../../../packages/sangfor-hci-client/src/index.js';
import { TowerClient } from './tower-client.js';
import { authorizeToolCall } from '../../http-bridge/src/tool-guard.js';
import {
  LearningStrategyService,
  assertSafeLearningInput,
} from '../../../packages/sangfor-learning-strategy/src/index.js';
import {
  ObserverSessionManager,
  type ObserverProfile,
  type ObserverTransport,
} from '../../../packages/sangfor-observer/src/index.js';
import { createDefaultJmBrowserRuntime } from './jm-browser-runtime.js';
import { createRemoteBrowserExecutionPortFromEnv } from './remote-browser-runtime.js';
import { captureKeyringFromEnv } from '../../../packages/sangfor-collector/src/capture-bundle.js';
import {
  configureIagOrchestratorToolService,
  iagOrchestratorToolCatalog,
} from './iag-orchestrator-tools.js';
import {
  getAuditFramework,
  listAuditFrameworkSummaries,
  filterChecklistItems,
  computeGapReport,
  type AuditGroup,
  type AuditOwner,
  type AuditPriority,
  type AuditObservation,
} from '../../../packages/sangfor-audit/src/index.js';

const pmStore = createPmStore(); // process-lifetime PM state for the MCP session

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: any };

type ToolHandler = (args: any) => unknown | Promise<unknown>;

const plans = new Map<string, any>();
let learningService: LearningStrategyService | undefined;
const currentLearningService = (): LearningStrategyService => learningService ??= new LearningStrategyService();
const pendingLearningCaptures = new Map<string, { sessionHandle: string; durationMs?: number; firmwareVersion?: string }>();
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

function requiredBrowserExecutionPort(): BrowserExecutionPort {
  if (!browserExecutionPort) throw new Error('JM_BROWSER_RUNTIME_REQUIRED: browser execution port is not configured.');
  return browserExecutionPort;
}

function requiredObserverTransport(): ObserverTransport {
  if (!observerTransport) throw new Error('JM_BROWSER_RUNTIME_REQUIRED: observer transport is not configured.');
  return observerTransport;
}

function requiredBrowserArtifactMaterializer() {
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

async function captureProductScreenshotsWithJm(
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

function learningArgs(args: unknown, keys: readonly string[]): Record<string, any> {
  assertSafeLearningInput(args, keys);
  return args as Record<string, any>;
}

function observerManager(): ObserverSessionManager {
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
function hciConnection(args: Record<string, unknown> = {}) {
  const identityBaseUrl = String(args.identityBaseUrl ?? process.env.SANGFOR_HCI_IDENTITY_URL ?? 'http://127.0.0.1:3400/openstack/identity/v2.0');
  return {
    identityBaseUrl,
    tenantName: String(args.tenantName ?? process.env.SANGFOR_HCI_TENANT ?? 'lab'),
    username: String(args.username ?? process.env.SANGFOR_HCI_USER ?? 'admin'),
    password: String(args.password ?? process.env.SANGFOR_HCI_PASSWORD ?? 'mock-password'),
    tlsSkipVerify: true,
    host: new URL(identityBaseUrl).hostname,
  };
}

function hciClientFor(args: Record<string, unknown> = {}) {
  const cfg = hciConnection(args);
  return { client: new HciClient(new KeystoneV2TokenProvider(cfg), { tlsSkipVerify: cfg.tlsSkipVerify }), cfg };
}

function hciAuthorityReferences() {
  const manifestPath = process.env.SANGFOR_CAPABILITY_EVIDENCE_MANIFEST;
  const validationContextPath = process.env.SANGFOR_CAPABILITY_EVIDENCE_CONTEXT;
  const evidenceRoot = process.env.SANGFOR_CAPABILITY_EVIDENCE_ROOT;
  const ledgerPath = process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_PATH;
  if (!manifestPath || !validationContextPath || !evidenceRoot || !ledgerPath) return undefined;
  return { manifestPath, validationContextPath, evidenceRoot, ledgerPath };
}

// ─── FortiOS / Cisco IOS-XE advisor wiring (read-only GET; never mutates) ──────
// `host` may be a bare IP/hostname (defaults to https://) or a full base URL
// (e.g. http://127.0.0.1:PORT), which lets tests point at a plain-HTTP mock
// without needing a self-signed TLS server.
function apiBaseUrl(host: string): string {
  return /^https?:\/\//i.test(host) ? host.replace(/\/$/, '') : `https://${host}`;
}

// evaluateSpec() takes a flat observedKey->value record; the client mappers
// return provenance-carrying ConfigStateItem[] — flatten one into the other.
function toObservedRecord(items: Array<{ observedKey: string; value: unknown }>): Record<string, unknown> {
  return Object.fromEntries(items.map((i) => [i.observedKey, i.value]));
}

// Shared privacy/verbosity control. Read tools advertise it so agents can ask
// for only the detail they need (summary | structured | raw). Honored by read
// tools (e.g. rag_search) to limit returned detail.
export const PRIVACY_MODE_SCHEMA = {
  type: 'string',
  enum: ['summary', 'structured', 'raw'],
  description: 'Privacy/verbosity mode: summary (concise), structured (default object), raw (full detail). Honored by read tools to limit returned detail.',
};

// Honor privacy_mode=summary on search tools: return only id/title/score instead
// of full chunk bodies, so agents can request less detail. structured/raw return
// the full result unchanged.
function summarizeSearchHits(hits: Array<{ id: string; title: string; score?: number }>) {
  return { count: hits.length, hits: hits.map((h) => ({ id: h.id, title: h.title, score: h.score })) };
}

// Opt-in cursor pagination for a handful of list tools that historically returned
// their whole array. Backward-compat contract: when the caller passes neither
// cursor nor limit, return the field unchanged (full array, no nextCursor) — the
// same shape those tools have always returned. Only pass cursor/limit to switch
// into a paginated `{ [fieldName]: page, nextCursor? }` response.
function paginateOptionalField<T>(
  allItems: T[],
  args: { cursor?: string; limit?: number },
  getKey: (item: T) => string,
  fieldName: string,
): Record<string, unknown> {
  if (args.cursor === undefined && args.limit === undefined) return { [fieldName]: allItems };
  const { items, nextCursor } = paginate(allItems, { cursor: args.cursor, limit: args.limit, getKey });
  return { [fieldName]: items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

// ─── C2: search-gap flywheel ───────────────────────────────────────────────
// A weak RAG hit (nothing found, or the best hit barely matches) is exactly
// the signal that should drive what gets ingested/authored next. Capture it
// to a feedback JSONL instead of silently discarding it; SANGFOR_SEARCH_GAP_CAPTURE=0
// disables capture entirely and a capture failure never fails the search itself.
const SEARCH_GAP_FILE = 'search-gaps.jsonl';
const DEFAULT_SEARCH_GAP_WEAK_THRESHOLD = 0.15;

interface SearchGapEvent {
  id: string;
  ts: string;
  query: string;
  product?: string;
  version?: string;
  hitCount: number;
  topScore?: number;
  reason: 'no_hits' | 'low_score';
}

function searchGapCaptureEnabled(): boolean {
  return process.env.SANGFOR_SEARCH_GAP_CAPTURE !== '0';
}

function searchGapWeakThreshold(): number {
  const raw = process.env.SANGFOR_RAG_WEAK_THRESHOLD;
  if (raw === undefined) return DEFAULT_SEARCH_GAP_WEAK_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEARCH_GAP_WEAK_THRESHOLD;
}

// Same root-resolution convention as packages/sangfor-feedback/src/index.ts:26
// (SANGFOR_FEEDBACK_ROOT override, else data/feedback anchored to the repo root),
// plus engagement scoping (see resolveEngagementScopedData) so search-gap
// capture isolates per customer engagement when SANGFOR_ENGAGEMENT_ID is set.
function feedbackRoot(): string {
  return resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
}

function searchGapFilePath(): string {
  return join(feedbackRoot(), SEARCH_GAP_FILE);
}

function recordSearchGap(input: { query: string; product?: string; version?: string; hitCount: number; topScore?: number; reason: 'no_hits' | 'low_score' }): void {
  if (!searchGapCaptureEnabled()) return;
  try {
    const event: SearchGapEvent = { id: nowId('search_gap'), ts: new Date().toISOString(), ...input };
    appendJsonl(searchGapFilePath(), event);
  } catch (error) {
    process.stderr.write(`[search-gap] failed to record search gap: ${String(error instanceof Error ? error.message : error)}\n`);
  }
}

function readSearchGaps(): SearchGapEvent[] {
  let raw: string;
  try {
    raw = readFileSync(searchGapFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SearchGapEvent);
}

// ─── C3: safety self-test ───────────────────────────────────────────────────
// In-process proof that the fail-closed gates actually refuse an unapproved
// action, with no device/network contact. Calls only existing exports — the
// gate/guard logic itself is never touched here. Each check is independently
// try/caught so one gate throwing (instead of returning a refusal) is reported
// as a finding rather than crashing the whole self-test.
interface SafetySelftestCheck {
  name: string;
  expectation: 'refused';
  outcome: 'refused' | 'allowed' | 'skipped';
  pass: boolean;
  detail: string;
}

const OPERATOR_GATE_CHECK_NAME = 'operator.assertRealExecutionAllowed';
const OPERATOR_GATE_SUBPROCESS_TIMEOUT_MS = 10_000;

// (1) @sangfor/operator's real-execution gate (assertRealExecutionAllowed) reads
// process.env.SANGFOR_ALLOW_REAL_EXECUTION / SANGFOR_OPERATOR_APPROVAL_SECRET
// directly, with no way to inject an override through its function signature —
// and this self-test must never mutate the PARENT process's env. So this proves
// the gate for real in a CHILD process instead: spawn node (no shell) running the
// gate function through the same tsx loader the bin launcher uses, with an
// explicitly-built minimal env that does NOT set SANGFOR_ALLOW_REAL_EXECUTION
// (never inherited from the parent — so the check proves fail-closed BY DEFAULT,
// not "whatever the parent happened to have set"). A non-dry-run call with no
// approval must throw; the child reports that over exit code + stdout.
// `timeoutMs` is overridable only for tests exercising the failure/timeout
// fallback — production always uses the 10s default.
function checkOperatorExecutionGate(opts: { timeoutMs?: number } = {}): SafetySelftestCheck {
  const timeoutMs = opts.timeoutMs ?? OPERATOR_GATE_SUBPROCESS_TIMEOUT_MS;
  let scriptDir: string | undefined;
  try {
    const repoRoot = resolveRepoData('.');
    const operatorIndexPath = join(repoRoot, 'packages/sangfor-operator/src/index.js');
    // Same resolution the bin launcher (bin/sangfor-engineer-mcp.mjs) uses to
    // find tsx without a shell/pnpm shim dependency.
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli', { paths: [repoRoot] });

    scriptDir = mkdtempSync(join(tmpdir(), 'sangfor-selftest-gate-'));
    const scriptPath = join(scriptDir, 'check-operator-gate.ts');
    const script = [
      `import { assertRealExecutionAllowed } from ${JSON.stringify(operatorIndexPath)};`,
      `const session = { id: 'selftest-subprocess', product: 'HCI', mode: 'lab', status: 'running' };`,
      `const action = { type: 'click', target: 'selftest-probe', dryRun: false };`,
      // The gate is async. It MUST be awaited inside an async main(): calling it
      // without awaiting resolves nothing, prints ALLOWED, and surfaces the real
      // refusal later as an unhandled rejection — a check that reports fail-OPEN
      // while the gate is in fact closed. tsx compiles this file to CJS, where
      // top-level await is unavailable, so the await lives in a function.
      `async function main() {`,
      `  try {`,
      `    await assertRealExecutionAllowed(session, action, undefined);`,
      `    process.stdout.write('ALLOWED\\n');`,
      `    process.exit(3);`,
      `  } catch (err) {`,
      `    process.stdout.write('REFUSED: ' + (err instanceof Error ? err.message : String(err)) + '\\n');`,
      `    process.exit(0);`,
      `  }`,
      `}`,
      `main();`,
    ].join('\n');
    writeFileSync(scriptPath, script);

    // Explicitly-built minimal env, NOT `{ ...process.env }` — inheriting the
    // parent's env could carry SANGFOR_ALLOW_REAL_EXECUTION (or an approval
    // secret) straight through and silently prove nothing. PATH/HOME are the
    // only entries a plain `node <tsx-cli> <script>` invocation needs.
    const minimalEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

    const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
      cwd: repoRoot,
      env: minimalEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: false,
    });

    if (result.error || result.signal) {
      return {
        name: OPERATOR_GATE_CHECK_NAME,
        expectation: 'refused',
        outcome: 'skipped',
        pass: true,
        detail: `subprocess spawn/timeout failed (${result.error ? result.error.message : `signal ${result.signal}`}) — skipped rather than mutate env; NOT proof the gate is safe, just that this run could not check it.`,
      };
    }
    const stdout = (result.stdout ?? '').trim();
    const refused = result.status === 0 && stdout.startsWith('REFUSED');
    return {
      name: OPERATOR_GATE_CHECK_NAME,
      expectation: 'refused',
      outcome: refused ? 'refused' : 'allowed',
      pass: refused,
      detail: refused
        ? `subprocess (clean env, no SANGFOR_ALLOW_REAL_EXECUTION) refused: ${stdout}`
        : `subprocess did NOT refuse (exit ${result.status}): ${stdout || (result.stderr ?? '').trim()}`,
    };
  } catch (error) {
    return {
      name: OPERATOR_GATE_CHECK_NAME,
      expectation: 'refused',
      outcome: 'skipped',
      pass: true,
      detail: `could not run the subprocess check (${String(error instanceof Error ? error.message : error)}) — skipped; NOT proof the gate is safe, just that this run could not check it.`,
    };
  } finally {
    if (scriptDir) {
      try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

// Exported (in addition to being wired as the sangfor_safety_selftest tool
// handler below) so tests can pass operatorGateTimeoutMs to exercise the
// spawn-timeout fallback deterministically — the MCP tool's own inputSchema
// takes no properties, so this override is not reachable over the wire.
export async function runSafetySelftest(opts: { operatorGateTimeoutMs?: number } = {}): Promise<{ checks: SafetySelftestCheck[]; skippedCount: number; allPass: boolean }> {
  const checks: SafetySelftestCheck[] = [];

  checks.push(checkOperatorExecutionGate({ timeoutMs: opts.operatorGateTimeoutMs }));

  // (2) http-bridge's tool-guard must refuse a destructive tool call with no approval.
  try {
    const toolListResult = { tools: [{ name: 'sangfor_selftest_destructive_probe', annotations: { readOnlyHint: false, destructiveHint: true } }] };
    const decision = await authorizeToolCall({ name: 'sangfor_selftest_destructive_probe', toolListResult, enforceWhitelist: true });
    const refused = decision.allow === false && decision.status === 403;
    checks.push({
      name: 'http-bridge.authorizeToolCall',
      expectation: 'refused',
      outcome: refused ? 'refused' : 'allowed',
      pass: refused,
      detail: refused ? `refused: ${decision.error}` : `NOT refused: ${JSON.stringify(decision)}`,
    });
  } catch (error) {
    checks.push({ name: 'http-bridge.authorizeToolCall', expectation: 'refused', outcome: 'allowed', pass: false, detail: `threw instead of returning a refusal: ${String(error instanceof Error ? error.message : error)}` });
  }

  // (3) A forged HMAC approval signature must be rejected.
  try {
    const secret = `selftest-${randomBytes(16).toString('hex')}`;
    const payload = canonicalizeApprovalPayload(['selftest', 'action', 'payload']);
    const forged = Buffer.alloc(32, 0x42);
    const verdict = verifyDomainApprovalSignature(secret, payload, forged);
    const refused = verdict.ok === false;
    checks.push({
      name: 'approval.verifyDomainApprovalSignature',
      expectation: 'refused',
      outcome: refused ? 'refused' : 'allowed',
      pass: refused,
      detail: refused ? `refused: ${verdict.reason}` : 'forged signature was accepted',
    });
  } catch (error) {
    checks.push({ name: 'approval.verifyDomainApprovalSignature', expectation: 'refused', outcome: 'allowed', pass: false, detail: `threw instead of returning a refusal: ${String(error instanceof Error ? error.message : error)}` });
  }

  // (4) A single-use nonce must refuse replay. Uses a throwaway temp-dir store —
  // never data/runtime's real nonce store.
  let nonceDir: string | undefined;
  try {
    nonceDir = mkdtempSync(join(tmpdir(), 'sangfor-selftest-nonce-'));
    const store = new FileSingleUseNonceStore(join(nonceDir, 'nonces.json'), resolveProductionLocalWriteAuthority({
      tenantId: 'selftest', projectId: 'selftest', actorId: 'selftest', aggregate: 'approvals_nonces', sourceRoot: nonceDir,
    }));
    const nonce = `selftest-${randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await store.consume(nonce, expiresAt);
    const second = await store.consume(nonce, expiresAt);
    const refused = first.ok === true && second.ok === false;
    checks.push({
      name: 'approval.FileSingleUseNonceStore replay',
      expectation: 'refused',
      outcome: refused ? 'refused' : 'allowed',
      pass: refused,
      detail: refused ? `replay refused: ${second.reason}` : `replay NOT refused (first.ok=${first.ok}, second.ok=${second.ok})`,
    });
  } catch (error) {
    checks.push({ name: 'approval.FileSingleUseNonceStore replay', expectation: 'refused', outcome: 'allowed', pass: false, detail: `threw instead of exercising the store: ${String(error instanceof Error ? error.message : error)}` });
  } finally {
    if (nonceDir) {
      try { rmSync(nonceDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }

  // allPass means "every EXECUTED check passed" — a skipped check contributes
  // neither a pass nor a fail to this aggregate (it was not proven either way,
  // see each skipped check's own detail). Counting a skip as a pass here would
  // let allPass:true silently hide an unverified gate; skippedCount surfaces
  // how many checks that applies to so a caller can't miss it.
  const executed = checks.filter((c) => c.outcome !== 'skipped');
  const skippedCount = checks.length - executed.length;
  return { checks, skippedCount, allPass: executed.every((c) => c.pass) };
}

const mcpLocalAuthority = (aggregate: string, sourceRoot: string) => resolveProductionLocalWriteAuthority({
  tenantId: process.env.SANGFOR_TENANT_ID ?? 'local-primary',
  projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary',
  actorId: 'mcp-server', aggregate, sourceRoot,
});
const auditRoot = () => join(resolveEngagementScopedData('data/evidence'), 'change-runs');
const wikiRoot = () => resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT');
const evalRoot = () => resolveRepoData('data/evals', 'SANGFOR_EVALS_ROOT');

const tools: Record<string, { description: string; inputSchema: any; handler: ToolHandler }> = {
  'sangfor_products': {
    description: 'List supported Sangfor products in current priority order.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ products: PRODUCTS })
  },
  'sangfor_hci_inventory': {
    description: `Read-only HCI/SCP inventory over the OpenAPI surface (volumes/servers/images). Auth contract: ${HCI_AUTH_CONTRACT_STATUS}.`,
    inputSchema: { type: 'object', properties: { identityBaseUrl: { type: 'string' }, tenantName: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } },
    handler: async (args: Record<string, unknown>) => {
      const { client } = hciClientFor(args);
      return { ...(await collectInventory(client)), authContract: HCI_AUTH_CONTRACT_STATUS };
    }
  },
  'sangfor_hci_health_report': {
    description: `Read-only HCI/SCP operations health report (volume status distribution, error volumes, findings) rendered as a Korean advisory. Never mutates. Auth contract: ${HCI_AUTH_CONTRACT_STATUS}.`,
    inputSchema: { type: 'object', properties: { identityBaseUrl: { type: 'string' }, tenantName: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } },
    handler: async (args: Record<string, unknown>) => {
      const { client, cfg } = hciClientFor(args);
      const inv = await collectInventory(client);
      const summary = summarizeHciHealth(inv);
      return { summary, report: renderHciHealthReport(summary, { host: cfg.host, collectedAt: new Date().toISOString() }), authContract: HCI_AUTH_CONTRACT_STATUS };
    }
  },
  'sangfor_hci_plan_create_volume': {
    description: 'Plan (no mutation): validate a create-volume intent, mint the idempotency clientToken, and describe the SignedApproval required to apply. No device mutation here; applying requires explicit user intent via the separate hci_apply_create_volume (signed, single-use approval).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: (args: { name: string; sizeGb: number; description?: string; identityBaseUrl?: string }) => {
      const clientToken = `cv-${randomBytes(8).toString('hex')}`;
      const problems = validateCreateVolumeInput({ name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken });
      const { cfg } = hciClientFor(args as Record<string, unknown>);
      return {
        ok: problems.length === 0, problems, mutationPerformed: false,
        plannedRequest: { method: 'POST', path: '/volumes', body: { volume: { name: args.name, size: args.sizeGb, description: args.description ?? null } }, idempotencyHeader: { 'X-Client-Token': clientToken } },
        clientToken,
        approvalRequired: { action: { type: 'hci.create-volume', target: `${cfg.host}:${args.name}` }, fields: ['approvedBy', 'approvalToken', 'changeTicketId', 'rollbackPlanId', 'nonce', 'expiresAt'], mint: 'scripts/mint-hci-approval.ts' },
        rollback: { op: 'hci.delete-volume', note: 'the single documented reverse op; requires its own approval' },
        authContract: HCI_AUTH_CONTRACT_STATUS,
      };
    }
  },
  'sangfor_hci_apply_create_volume': {
    description: 'WRITE: apply a planned create-volume through the state machine (idempotent POST -> read-back verify -> succeed or HALT). Requires explicit signed approval (action-bound, single-use nonce). On a non-loopback (real device) target it is additionally gated by SANGFOR_ALLOW_REAL_EXECUTION and an auto_allowed safety class (volume_create stays human_only until the M4 real-device promotion). Over the HTTP bridge it additionally needs a bridge-level bridge.tool-call approval.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, clientToken: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb', 'clientToken', 'approval'] },
    handler: async (args: { name: string; sizeGb: number; description?: string; clientToken: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as Record<string, unknown>);
      assertLocalAuditAuthorityAllowed();
      const authorization = await authorizeHciMutation({
        action: {
          kind: 'hci.create-volume', target: `${cfg.host}:${args.name}`,
          identityBaseUrl: cfg.identityBaseUrl, capabilityId: 'volume_create',
        },
        approval: args.approval,
        authority: hciAuthorityReferences(),
      });
      if (authorization.kind === 'REFUSED') return { ok: false, mutationPerformed: false, error: authorization.code };
      const result = await applyCreateVolume(client, { name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken: args.clientToken }, new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) }));
      return {
        ...result, mutationPerformed: result.finalState === 'SUCCEEDED' || Boolean(result.volumeId),
        ledger: new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) }).pathFor(result.runId),
      };
    }
  },
  'sangfor_hci_verify_volume': {
    description: 'Read-only read-back verification of a volume against an expectation (PASS/FAIL/INDETERMINATE; INDETERMINATE never passes).',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, name: { type: 'string' }, sizeGb: { type: 'number' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: async (args: { volumeId?: string; name: string; sizeGb: number; identityBaseUrl?: string }) => {
      const { client } = hciClientFor(args as Record<string, unknown>);
      return readBackVolume(client, { volumeId: args.volumeId, name: args.name, sizeGb: args.sizeGb });
    }
  },
  'sangfor_hci_delete_volume': {
    description: 'DESTRUCTIVE: delete a volume (the reverse op of create). Requires a SignedApproval bound to the exact volumeId. Over the HTTP bridge it additionally needs a bridge-level bridge.tool-call approval, and on a non-loopback (real) device it is refused until volume_delete is promoted out of human_only. Gated by SANGFOR_ALLOW_REAL_EXECUTION and requires explicit signed approval bound to the exact volumeId.',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['volumeId', 'approval'] },
    handler: async (args: { volumeId: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as Record<string, unknown>);
      assertLocalAuditAuthorityAllowed();
      const authorization = await authorizeHciMutation({
        action: {
          kind: 'hci.delete-volume', target: `${cfg.host}:${args.volumeId}`,
          identityBaseUrl: cfg.identityBaseUrl, capabilityId: 'volume_delete',
        },
        approval: args.approval,
        authority: hciAuthorityReferences(),
      });
      if (authorization.kind === 'REFUSED') return { ok: false, mutationPerformed: false, error: authorization.code };
      const before = await getVolume(client, args.volumeId);
      if (!before) return { ok: false, mutationPerformed: false, error: `volume ${args.volumeId} not found` };
      const res = await deleteVolume(client, args.volumeId);
      const ledger = new AuditLedger({ authority: mcpLocalAuthority('audit', auditRoot()) });
      const runId = nowId('hci_delete');
      await ledger.append(runId, 'request', { op: 'delete-volume', volumeId: args.volumeId, before });
      await ledger.append(runId, 'response', { status: res.status });
      return { ok: res.status === 202, mutationPerformed: res.status === 202, status: res.status, runId };
    }
  },
  'sangfor_discover_product_console': {
    description: 'Discover product console strategy, login/API likelihood, menu routes and product capabilities for HCI/SCP, IAG, Endpoint Secure or NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: discoverProductConsole
  },
  'sangfor_collect_product_config': {
    description: 'Collect or plan read-only collection of current product configuration. Uses API-first for HCI/SCP, WebUI-first for IAG/Endpoint Secure, hybrid for NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: collectProductConfig
  },
  'sangfor_analyze_customer_requirements': {
    description: 'Break customer requirement strings into product-specific configuration tasks with menu paths, API candidates, risk and approval gates.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: analyzeCustomerRequirements
  },
  'sangfor_generate_product_change_plan': {
    description: 'Generate product change plan with menu path, API endpoint candidates, current/target planning context, impact/risk, rollback and validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: generateProductChangePlan
  },
  'sangfor_import_excel_requirement_list': {
    description: 'Import an ITAC-style Excel checklist and normalize rows into configuration requirements, evidence needs, target controls, gaps and priority.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } }, required: ['filePath'] },
    handler: importExcelRequirementList
  },
  'sangfor_map_requirements_to_products': {
    description: 'Map normalized Excel checklist rows to HCI/SCP, IAG, Endpoint Secure, NDR, or external/manual handling.',
    inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } }, required: ['rows'] },
    handler: mapRequirementsToProducts
  },
  'sangfor_generate_excel_based_change_plan': {
    description: 'Generate a multi-product dry-run change plan from an ITAC-style Excel checklist. Actual mutation remains blocked.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } } },
    handler: generateExcelBasedChangePlan
  },
  'sangfor_generate_setting_guide_docx': {
    description: 'Generate a Word (.docx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted document with product tables, manual evidence section, dry-run procedure, and customer action items.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string }) => buildSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath })
  },
  'sangfor_generate_setting_guide_pptx': {
    description: 'Generate a PowerPoint (.pptx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted presentation with product-specific slides, tables, charts, and dry-run procedures.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .pptx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildSettingGuidePptx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor_generate_operations_guide_pptx': {
    description: 'Generate a PowerPoint (.pptx) operations guide for Sangfor products covering daily monitoring, weekly/monthly procedures, incident response, and security policies.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .pptx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuidePptx({ outputPath: args.outputPath })
  },
  'sangfor_generate_operations_guide_docx': {
    description: 'Generate a Word (.docx) operations guide for Sangfor products covering daily monitoring, weekly/monthly inspection, incident response, and security policy management.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuideDocx({ outputPath: args.outputPath })
  },
  'sangfor_generate_comprehensive_setting_guide_docx': {
    description: 'Generate a comprehensive Word (.docx) customer setting guide with detailed setup procedures, product-specific configuration, operational steps, security policies, backup/recovery, and troubleshooting. Much more detailed than the basic setting guide.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor_generate_comprehensive_operations_guide_docx': {
    description: 'Generate a comprehensive Word (.docx) operations guide covering detailed daily/weekly/monthly procedures, incident response, backup/recovery, security policy management, performance monitoring, and troubleshooting FAQ.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } } },
    handler: (args: { outputPath?: string; screenshotDir?: string }) => buildComprehensiveOperationsGuideDocx({ outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor_validate_office_document': {
    description: 'Read-only: validate a .docx/.xlsx/.pptx against the OpenXML schema via officecli, for a pre-submission sanity check before handing a generated document to a customer. Returns {valid, errorCount, errors, note?} plus officecli availability — valid:null (not false) when officecli is not installed on this host, so a missing officecli is never mistaken for a broken document.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the .docx/.xlsx/.pptx file to validate.' },
      },
      required: ['filePath'],
    },
    handler: async (args: { filePath: string }) => {
      const availability = isOfficeCliAvailable();
      const validation = await validateOfficeDocument(args.filePath);
      return { ...validation, officeCli: availability };
    },
  },
  'sangfor_capture_screenshots': {
    description: 'Capture screenshots from Sangfor product consoles (EPP, IAG, CC) via Chrome CDP. Connects to the product console, logs in, navigates menus, and saves screenshots.',
    inputSchema: { type: 'object', properties: { product: { type: 'string', enum: ['EPP', 'IAG', 'CC'], description: 'Product to capture screenshots from' }, targetUrl: { type: 'string', description: 'Override target URL' }, username: { type: 'string', description: 'Login username' }, password: { type: 'string', description: 'Login password' }, outputDir: { type: 'string', description: 'Output directory for screenshots' }, cdpPort: { type: 'number', description: 'Optional loopback Chrome CDP port' }, headless: { type: 'boolean', description: 'Run Chrome in headless mode' }, dryRun: { type: 'boolean', description: 'Dry-run mode: skip Chrome and just list planned screenshots' } }, required: ['product'] },
    handler: captureProductScreenshotsWithJm,
  },
  'sangfor_console_capture_evidence': {
    description: 'Read-only console evidence capture: attaches to a Chrome you already have open on the product console (via a trusted SANGFOR_JM_CDP_PROFILES_JSON port/origin binding; never launches a browser) and screenshots the listed menus/URLs as named audit evidence (REQ##_product_menu_Before_YYYYMMDD.png), hash-chained into the AuditLedger. reads console screens only; never changes device configuration. Chrome must already be running with --remote-debugging-port=<cdpPort> (default 9222). Omit outputDir to use the engagement-scoped default data/evidence/captures/<YYYYMMDD>/.',
    inputSchema: {
      type: 'object',
      properties: {
        cdpPort: { type: 'number', description: 'Chrome remote-debugging port to attach to. Default 9222.' },
        product: { type: 'string', description: 'Product code, e.g. ENDPOINT_SECURE, IAG, CYBER_COMMAND, HCI_SCP (see sangfor_products). Aliases like EPP/CC are also accepted.' },
        captures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reqId: { type: 'string', description: 'ITAC requirement id, e.g. "01" — becomes REQ01 in the filename.' },
              menuLabel: { type: 'string', description: 'Human label for the console screen; used in the filename.' },
              menuPath: {
                type: 'array',
                items: { type: 'object', properties: { menu: { type: 'string' }, submenu: { type: 'string' } }, required: ['menu'] },
                description: 'Optional menu/submenu text-click path (read-only navigation only — no form submission).',
              },
              url: { type: 'string', description: 'Optional URL to navigate to before capture.' },
            },
            required: ['reqId', 'menuLabel'],
          },
        },
        outputDir: { type: 'string', description: 'Output directory for PNGs. Omit for the engagement-scoped default.' },
        dateStamp: { type: 'string', description: 'Override the YYYYMMDD stamp used in filenames and the default outputDir. Default: today.' },
        deviceId: { type: 'string', description: 'Which appliance these captures came from, e.g. iag-hq-01. Separates two devices of the same product within one customer engagement: adds a <deviceId> folder under the date and a device token to each filename. Omit when unknown.' },
        engagementId: { type: 'string', description: 'Optional engagement id recorded in the ledger payload.' },
      },
      required: ['product', 'captures'],
    },
    handler: async (args: { cdpPort?: number; product: string; captures: Array<{ reqId: string; menuLabel: string; menuPath?: Array<{ menu: string; submenu?: string }>; url?: string }>; outputDir?: string; dateStamp?: string; engagementId?: string; deviceId?: string }) => {
      const product = normalizeProduct(args.product);
      const dateStamp = args.dateStamp ?? formatCaptureDateStamp(new Date());
      // customer (engagement-scoped root) / date / device
      const outputDir = args.outputDir ?? join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), buildCaptureRelativeDir(dateStamp, args.deviceId));
      resolveConfinedOutputDir(outputDir);
      const targetUrl = args.captures.find((capture) => capture.url)?.url
        ?? process.env.SANGFOR_CONSOLE_URL
        ?? 'http://127.0.0.1:3400';
      const cdpPort = args.cdpPort ?? DEFAULT_CONSOLE_CDP_PORT;
      const session = startOperatorSession({
        product,
        mode: 'customer_readonly',
        targetUrl,
        browser: { useLocalBrowser: true, cdpPort },
      });
      try {
        return await captureConsoleEvidence({
          product,
          captures: args.captures,
          outputDir,
          deviceId: args.deviceId,
          dateStamp,
          engagementId: args.engagementId,
        }, {
          executionPort: requiredBrowserExecutionPort(),
          sessionId: session.id,
          origin: new URL(targetUrl).origin,
          materializeArtifact: requiredBrowserArtifactMaterializer(),
        });
      } finally {
        await closeOperatorSession(session.id, requiredBrowserExecutionPort());
      }
    },
  },
  'sangfor_verify_capture_ledger': {
    description: 'Read-only: verify a sangfor_console_capture_evidence run — the AuditLedger hash-chain integrity (chainOk) AND, per captured file, whether its current on-disk sha256 still matches the hash recorded at capture time (tamper detection).',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'runId returned by sangfor_console_capture_evidence.' } }, required: ['runId'] },
    handler: (args: { runId: string }) => {
      if (!isSafeRunId(args.runId)) return { error: `INVALID_RUN_ID: "${args.runId}" is not a safe path segment.` };
      return verifyCaptureLedger(args.runId);
    },
  },
  'sangfor_generate_all_guides': {
    description: 'Generate complete guide set: setting guide (docx + pptx), operations guide (docx + pptx), and optionally capture screenshots. Uses the ITAC Excel as input.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputDir: { type: 'string', description: 'Output directory for all guides' }, screenshotDir: { type: 'string', description: 'Directory containing product screenshots (default: outputs/final_images)' }, captureScreenshots: { type: 'boolean', description: 'Also capture product console screenshots' }, screenshotProducts: { type: 'array', items: { type: 'string' }, description: 'Products to capture screenshots for (EPP, IAG, CC)' } }, required: ['filePath'] },
    handler: async (args: { filePath: string; outputDir?: string; screenshotDir?: string; captureScreenshots?: boolean; screenshotProducts?: string[] }) => {
      const outDir = args.outputDir ?? join(process.cwd(), 'outputs');
      const screenshotDir = args.screenshotDir ?? join(process.cwd(), 'outputs', 'final_images');
      mkdirSync(outDir, { recursive: true });
      const results: Record<string, unknown> = {};
      try {
        results.settingDocx = await buildSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.docx') });
      } catch (err) { results.settingDocxError = String(err); }
      try {
        results.settingPptx = await buildSettingGuidePptx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.pptx') });
      } catch (err) { results.settingPptxError = String(err); }
      try {
        results.operationsPptx = await buildOperationsGuidePptx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.pptx') });
      } catch (err) { results.operationsPptxError = String(err); }
      try {
        results.operationsDocx = await buildOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.docx') });
      } catch (err) { results.operationsDocxError = String(err); }
      try {
        results.comprehensiveSettingDocx = await buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveSettingDocxError = String(err); }
      try {
        results.comprehensiveOpsDocx = await buildComprehensiveOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveOpsDocxError = String(err); }
      if (args.captureScreenshots) {
        const products = args.screenshotProducts ?? ['EPP', 'IAG', 'CC'];
        results.screenshots = {};
        for (const product of products) {
          try {
            (results.screenshots as Record<string, unknown>)[product] = await captureProductScreenshotsWithJm({
              product: product as 'EPP' | 'IAG' | 'CC',
              outputDir: join('guide-screenshots', product),
              username: process.env[`SANGFOR_${product}_USERNAME`],
              password: process.env[`SANGFOR_${product}_PASSWORD`],
            });
          } catch (err) {
            (results.screenshots as Record<string, unknown>)[product] = { error: String(err) };
          }
        }
      }
      return results;
    }
  },
  'sangfor_dry_run_product_change': {
    description: 'Dry-run a product change plan. WebUI route preview stops before Save/Apply/Delete; API changes produce request previews only.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, targetUrl: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: (args) => dryRunProductChange({
      ...args,
      ...(args.sessionId
        ? { browserExecutionPort: requiredBrowserExecutionPort() }
        : {}),
    })
  },
  'sangfor_apply_approved_product_change': {
    description: 'Deprecated write surface: typed-refuses every real apply. Use a verified product-specific orchestrator; dry-run planning remains available separately.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, approval: { type: 'object' }, environment: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: applyApprovedProductChange
  },
  'sangfor_verify_product_change': {
    description: 'Verify a product change with read-only API/WebUI re-collection checklist and evidence expectations.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, observed: { type: 'object' } }, required: ['plan'] },
    handler: verifyProductChange
  },
  ...iagOrchestratorToolCatalog(requiredBrowserExecutionPort),
  'sangfor_search_manuals': {
    description: 'Search Sangfor manual/guide chunks by product, version and query. Supports privacy_mode (summary|structured|raw).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, privacy_mode: PRIVACY_MODE_SCHEMA }, required: ['product'] },
    handler: (args: { product?: string; version?: string; query?: string; limit?: number; privacy_mode?: 'summary' | 'structured' | 'raw' }) => {
      const hits = searchManuals(args);
      return args.privacy_mode === 'summary' ? summarizeSearchHits(hits) : hits;
    }
  },
  'sangfor_get_manual_section': {
    description: 'Get one manual section by chunk id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: ({ id }) => getManualSection(id) ?? { error: `Manual section not found: ${id}` }
  },
  'sangfor_search_wiki': {
    description: 'Search internal wiki chunks by product, version and query. Supports privacy_mode (summary|structured|raw).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, privacy_mode: PRIVACY_MODE_SCHEMA }, required: ['product'] },
    handler: (args: { product?: string; version?: string; query?: string; limit?: number; privacy_mode?: 'summary' | 'structured' | 'raw' }) => {
      const hits = searchWiki(args);
      return args.privacy_mode === 'summary' ? summarizeSearchHits(hits) : hits;
    }
  },
  'sangfor_list_knowledge_cards': {
    description: 'List source-cited structured knowledge cards used by the internal wiki/card retrieval layer.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => listKnowledgeCards()
  },
  'sangfor_upsert_knowledge_card': {
    description: 'Create or update a source-cited structured knowledge card. Requires at least one citation; does not write to devices.',
    inputSchema: { type: 'object', properties: { card: { type: 'object' } }, required: ['card'] },
    handler: ({ card }: { card: Parameters<typeof upsertKnowledgeCard>[0] }) => upsertKnowledgeCard(card, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  },

  'sangfor_ingest_document': {
    description: 'Parse PDF/HTML/Markdown/TXT document, chunk it, create local vector index, and store searchable RAG chunks.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, sourceType: { type: 'string' }, trustLevel: { type: 'string' }, title: { type: 'string' }, indexPath: { type: 'string' } }, required: ['filePath', 'product'] },
    handler: ingestDocument
  },
  'sangfor_rag_search': {
    description: 'Search real ingested local RAG index by product/version/query. Supports privacy_mode (summary|structured|raw) to limit returned detail. Hit embedding vectors are omitted by default — pass include_vectors:true to get them back.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, sourceType: { type: 'string', enum: ['manual', 'wiki', 'lesson', 'pattern'] }, trustLevel: { type: 'string', enum: ['official', 'internal', 'draft', 'needs_review', 'customer'] }, query: { type: 'string' }, limit: { type: 'number' }, indexPath: { type: 'string' }, privacy_mode: PRIVACY_MODE_SCHEMA, include_vectors: { type: 'boolean', description: 'Include each hit\'s raw embedding vector. Default false — vectors are large and rarely needed by callers.' } }, required: ['query'] },
    handler: async (args: { query: string; product?: string; version?: string; sourceType?: 'manual' | 'wiki' | 'lesson' | 'pattern'; trustLevel?: 'official' | 'internal' | 'draft' | 'needs_review' | 'customer'; limit?: number; indexPath?: string; privacy_mode?: 'summary' | 'structured' | 'raw'; include_vectors?: boolean }) => {
      if (args.sourceType !== undefined && !['manual', 'wiki', 'lesson', 'pattern'].includes(args.sourceType)) {
        throw new Error(`INVALID_SOURCE_TYPE: ${args.sourceType}`);
      }
      if (args.trustLevel !== undefined && !['official', 'internal', 'draft', 'needs_review', 'customer'].includes(args.trustLevel)) {
        throw new Error(`INVALID_TRUST_LEVEL: ${args.trustLevel}`);
      }
      const hits = await ragSearch(args);
      const diagnostics = getRagSearchDiagnostics();
      // C2 search-gap flywheel: a weak result (nothing found, or the best hit
      // barely matches) is a signal for what to ingest/author next — capture it
      // instead of silently discarding it. Never blocks or fails the search.
      const topScore = hits.length ? Math.max(...hits.map((h) => h.score ?? 0)) : undefined;
      const weakReason: 'no_hits' | 'low_score' | undefined = hits.length === 0
        ? 'no_hits'
        : (topScore !== undefined && topScore < searchGapWeakThreshold() ? 'low_score' : undefined);
      if (weakReason) {
        recordSearchGap({ query: args.query, product: args.product, version: args.version, hitCount: hits.length, topScore, reason: weakReason });
      }
      // privacy_mode=summary already returns an object ({count, hits}) — merge
      // diagnostics into it there. The default/structured/raw response is a
      // plain hits array (existing contract callers rely on); merging
      // diagnostics into it would require wrapping the array in an object and
      // is out of scope here, so degraded status stays reachable only via this
      // object-shaped response and sangfor_rag_index_summary.
      if (args.privacy_mode === 'summary') {
        const summarized = summarizeSearchHits(hits);
        return diagnostics.degraded ? { ...summarized, ...diagnostics } : summarized;
      }
      return args.include_vectors ? hits : hits.map(omitVectorFromHit);
    }
  },
  'sangfor_rag_index_summary': {
    description: 'Return summary of the real local RAG index.',
    inputSchema: { type: 'object', properties: { indexPath: { type: 'string' } } },
    handler: ({ indexPath }) => exportRagIndexSummary(indexPath)
  },
  'sangfor_store_health': {
    description: 'Check PostgreSQL persistence (Prisma) when DATABASE_URL is configured.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => storeHealthCheck()
  },
  'sangfor_learn_sources': {
    description: 'Collect Sangfor KB catalog, Community threads, ingest demo docs, update local RAG index and fine-tune JSONL. Uses .env / SANGFOR_ONE_ACCESS_TOKEN when present.',
    inputSchema: {
      type: 'object',
      properties: {
        communityMaxThreadsPerForum: { type: 'number', description: 'Per forum; omit for all threads on listing page' },
        knowledgeMaxArticles: { type: 'number', description: 'KB catalog cap; omit for full catalog' },
        includeDemoDocs: { type: 'boolean' },
        ragIndexPath: { type: 'string' },
        rawDir: { type: 'string' }
      }
    },
    handler: async (args) => {
      loadEnvFile('.env');
      return runLearnSourcesPipeline({
        communityMaxThreadsPerForum: args.communityMaxThreadsPerForum,
        knowledgeMaxArticles: args.knowledgeMaxArticles,
        includeDemoDocs: args.includeDemoDocs,
        ragIndexPath: args.ragIndexPath,
        rawDir: args.rawDir,
        ingestDocumentFn: ingestDocument,
        exportRagSummaryFn: exportRagIndexSummary,
        createFineTuneDatasetFn: createFineTuneDataset,
        validateFineTuneDatasetFn: validateFineTuneDataset
      });
    }
  },
  'sangfor_analyze_project': {
    description: 'Analyze customer project input and return product, project type, risk, missing inputs and knowledge queries.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName'] },
    handler: analyzeProject
  },
  'sangfor_generate_config_plan': {
    description: 'Generate a configuration plan with precheck, steps, rollback, validation and approval gates.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName', 'product'] },
    handler: async (args) => {
      const plan = await generateConfigPlanAsync(args);
      plans.set(plan.id, plan);
      const dbId = await persistConfigPlan(plan).catch(() => null);
      return dbId ? { ...plan, persistedId: dbId } : plan;
    }
  },
  'sangfor_validate_config_plan': {
    description: 'Validate that a generated plan has precheck, steps, rollback, validation and references.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => validateConfigPlan(plan ?? plans.get(planId))
  },
  'sangfor_request_approval': {
    description: 'Classify text/action risk and return approval decision.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: ({ text }) => requiresApprovalForText(text)
  },
  'sangfor_start_operator_session': {
    description: 'Start a mock/lab/poc/customer operator session. MVP defaults to mock.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, mode: { type: 'string' }, targetUrl: { type: 'string' }, browser: { type: 'object', properties: { cdpEndpoint: { type: 'string' }, useLocalBrowser: { type: 'boolean' } } } }, required: ['product'] },
    handler: startOperatorSession
  },
  'sangfor_read_console_state': {
    description: 'Read current mock console state for a session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => readConsoleState(sessionId)
  },
  'sangfor_execute_console_action': {
    description: 'Execute or dry-run a console action. MVP blocks high-risk non-dry-run operations.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: ({ sessionId, action }) => executeConsoleAction(sessionId, action)
  },

  'sangfor_read_live_console_state': {
    description: 'Read live Sangfor Web Console state using Playwright. Requires targetUrl session. Read-only snapshot.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: (args) => readLiveConsoleState({ ...args, executionPort: requiredBrowserExecutionPort() })
  },
  'sangfor_execute_console_action_live': {
    description: 'Execute a real Playwright console action. Requires SANGFOR_ALLOW_REAL_EXECUTION and approval fields for non-dry-run.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' }, approval: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: (args) => executeLiveConsoleAction({ ...args, executionPort: requiredBrowserExecutionPort() })
  },
  'sangfor_kill_session': {
    description: 'Cancel an operator session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => closeOperatorSession(
      sessionId,
      requiredBrowserExecutionPort(),
    ),
  },
  'sangfor_verify_result': {
    description: 'Verify plan/result. MVP returns manual validation checklist.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, observed: { type: 'object' } } },
    handler: ({ planId, plan, observed }) => verifyResult({ plan: plan ?? plans.get(planId), observed })
  },
  'sangfor_generate_evidence_report': {
    description: 'Generate Markdown evidence report for a plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, verification: { type: 'object' }, format: { type: 'string' } } },
    handler: ({ planId, plan, verification, format }) => {
      const rawPlan = plan ?? plans.get(planId);
      // Excel plans have workPlan instead of ConfigPlan fields — normalize
      const normalizedPlan = rawPlan?.workPlan ? {
        id: rawPlan.id ?? planId ?? 'unknown',
        product: rawPlan.product ?? 'MULTI_PRODUCT',
        planTitle: rawPlan.summary ?? 'Excel-based plan',
        planSummary: rawPlan.summary ?? '',
        customerName: '',
        riskLevel: 'medium',
        approvalRequiredSteps: [],
        manualReferences: [],
        wikiReferences: [],
        lessonReferences: [],
        steps: (rawPlan.workPlan ?? []).filter((w: any) => w.product !== 'external_or_manual').map((w: any) => ({ id: w.requestId, title: w.setting, description: w.description, product: w.product, phase: 'config' as const, approvalRequired: false, riskLevel: 'low' as any, references: [] })),
        precheck: [],
        rollbackPlan: [],
        validationPlan: (rawPlan.workPlan ?? []).map((w: any) => ({ id: w.requestId, title: w.setting, description: w.description, product: w.product, phase: 'validation' as const, approvalRequired: false, riskLevel: 'low' as any, references: [] })),
      } : rawPlan;
      return generateEvidenceReport({ plan: normalizedPlan, verification, format });
    }
  },
  'sangfor_submit_feedback': {
    description: 'Submit feedback linked to a product/plan/session.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, feedbackType: { type: 'string' }, severity: { type: 'string' }, feedbackText: { type: 'string' }, sourceRole: { type: 'string' } }, required: ['product', 'feedbackType', 'severity', 'feedbackText', 'sourceRole'] },
    handler: async (args) => {
      const event = await submitFeedback(args, mcpLocalAuthority('feedback_lessons', feedbackRoot()));
      const dbId = await persistFeedbackEvent(event).catch(() => null);
      return dbId ? { ...event, persistedId: dbId } : event;
    }
  },
  'sangfor_extract_lesson': {
    description: 'Extract a lesson learned from feedback.',
    inputSchema: { type: 'object', properties: { feedbackId: { type: 'string' } }, required: ['feedbackId'] },
    handler: ({ feedbackId }) => extractLesson(feedbackId, mcpLocalAuthority('feedback_lessons', feedbackRoot()))
  },
  'sangfor_propose_wiki_update': {
    description: 'Create a wiki update proposal from a lesson. Does not directly modify wiki. Creates a pending_review proposal only; applying it requires explicit human approval (reviewer token). Requires explicit reviewer consent before any wiki change.',
    inputSchema: { type: 'object', properties: { lessonTitle: { type: 'string' }, lessonBody: { type: 'string' }, targetPage: { type: 'string' } }, required: ['lessonTitle', 'lessonBody'] },
    handler: (input) => proposeWikiUpdate(input, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  },
  'sangfor_approve_wiki_update': {
    description: 'Approve or reject a wiki update proposal. Requires explicit reviewer token to confirm the approve/reject decision.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, decision: { type: 'string' }, token: { type: 'string' }, reviewer: { type: 'string' } }, required: ['proposalId', 'decision'] },
    handler: ({ proposalId, decision, token, reviewer }) => approveWikiUpdate(proposalId, decision, { token, reviewer }, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  },
  'sangfor_apply_wiki_update': {
    description: 'Apply an approved wiki update proposal. Blocks pending proposals. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
    handler: ({ proposalId }) => applyWikiUpdate(proposalId, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  },

  'sangfor_apply_obsidian_wiki_update': {
    description: 'Apply an approved wiki update proposal to an Obsidian vault path. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, vaultPath: { type: 'string' } }, required: ['proposalId', 'vaultPath'] },
    handler: ({ proposalId, vaultPath }) => applyObsidianWikiUpdate({
      proposalId, vaultPath, proposalAuthority: mcpLocalAuthority('wiki_proposals', wikiRoot()),
      adapterAuthority: mcpLocalAuthority('wiki_proposals', vaultPath),
    })
  },
  'sangfor_apply_github_wiki_update': {
    description: 'Apply an approved wiki update proposal to a GitHub Wiki git repository. Uses git CLI and provided repoUrl/localPath. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, repoUrl: { type: 'string' }, localPath: { type: 'string' } }, required: ['proposalId', 'repoUrl'] },
    handler: ({ proposalId, repoUrl, localPath }) => {
      const targetRoot = localPath ?? 'data/wiki/github-wiki';
      return applyGitHubWikiUpdate({
        proposalId, repoUrl, localPath: targetRoot, proposalAuthority: mcpLocalAuthority('wiki_proposals', wikiRoot()),
        adapterAuthority: mcpLocalAuthority('wiki_proposals', targetRoot),
      });
    }
  },
  'sangfor_create_eval_case_from_feedback': {
    description: 'Create planner regression eval case from feedback. Local-only evals-store write; requires explicit product, name and requiredText, and never touches a device.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, name: { type: 'string' }, requiredText: { type: 'string' } }, required: ['product', 'name', 'requiredText'] },
    handler: (input) => createEvalCaseFromFeedback(input, mcpLocalAuthority('evals', evalRoot()))
  },

  'sangfor_create_finetune_dataset': {
    description: 'Create JSONL fine-tuning dataset from reviewed Sangfor examples. Blocks secrets during validation step. Local-only dataset write; requires explicit examples and blocks secrets during validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, taskType: { type: 'string' }, examples: { type: 'array' }, outputPath: { type: 'string' } }, required: ['product', 'taskType', 'examples'] },
    handler: createFineTuneDataset
  },
  'sangfor_validate_finetune_dataset': {
    description: 'Validate JSONL fine-tuning dataset for structure and obvious sensitive data.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: ({ path }) => validateFineTuneDataset(path)
  },
  'sangfor_create_finetune_job_spec': {
    description: 'Create a reviewed fine-tuning job manifest. Does not submit automatically. Local-only manifest write; does not submit — running a job requires explicit external action.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, baseModel: { type: 'string' }, datasetPath: { type: 'string' }, validationDatasetPath: { type: 'string' }, product: { type: 'string' }, taskType: { type: 'string' } }, required: ['datasetPath', 'product', 'taskType'] },
    handler: createFineTuneJobSpec
  },
  'sangfor_run_planner_eval': {
    description: 'Run built-in planner evals against a generated config plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => runPlannerEval(plan ?? plans.get(planId))
  },
  'sangfor_evaluate_config': {
    description: 'Advisory (read-only) config check: compare an observed product config against an IntendedSpec (from manuals) and split findings into misconfiguration / missing / indeterminate / ok. Never mutates a device. INDETERMINATE never counts as pass; MUST items without a source citation stay indeterminate. Returns the evaluation and a Korean advisory report; pass docxPath to also write a .docx.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, observed: { type: 'object', description: 'observed config key→value map (from screenshot/backup/human)' }, spec: { type: 'object', description: 'optional inline IntendedSpec; if omitted, loaded by product+version' }, docxPath: { type: 'string', description: 'optional path to also write the report as a .docx' } }, required: ['observed'] },
    handler: (args: { product?: string; version?: string; observed: Record<string, unknown>; spec?: IntendedSpec; docxPath?: string }) => {
      const spec = args.spec ?? (args.product && args.version ? loadSpec(args.product, args.version) : null);
      if (!spec) return { error: `No IntendedSpec found for ${args.product ?? '?'} ${args.version ?? '?'}. Provide an inline spec or seed data/specs/. Coverage: ${JSON.stringify(listSpecCoverage())}` };
      const result = evaluateSpec(spec, args.observed ?? {});
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { result, report, ...(docx ? { docx } : {}) };
    }
  },
  'sangfor_list_spec_coverage': {
    description: 'List which product/version IntendedSpecs exist (advisory coverage) so callers know what config checks are available. Optional cursor/limit page the list; omit both for the full list (default, backward-compatible).',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => {
      // listSpecCoverage() has no inherent order (directory listing) — sort by
      // product+version first so the same cursor always resumes at the same row.
      const sorted = [...listSpecCoverage()].sort((a, b) =>
        a.product === b.product ? a.version.localeCompare(b.version) : a.product.localeCompare(b.product));
      return paginateOptionalField(sorted, args, (c) => `${c.product}::${c.version}`, 'coverage');
    }
  },
  'sangfor_advisor_fortios': {
    description: 'Read-only self-assessment advisor for FortiOS firewalls (policies, interfaces, routing). HTTP GET only against the REST API; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'FortiOS device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 8.0.0)', default: '8.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const { status, json, text } = await httpJson(`${apiBaseUrl(args.host)}/api/v2/firewall/policy`, {
          headers: { Authorization: `Basic ${auth}` },
          tlsSkipVerify: true,
        });
        if (status < 200 || status >= 300) throw new Error(`FortiOS API returned HTTP ${status}: ${text.slice(0, 200)}`);
        const configState = mapFortiOSConfigState(json, 'api');
        const evaluation = evaluateSpec(fortios_policy_baseline, toObservedRecord(configState));
        return { product: 'FORTIOS', device: args.host, evaluation, timestamp };
      } catch (err) {
        return { product: 'FORTIOS', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  },
  'sangfor_advisor_fortios_advanced': {
    description: 'Advanced read-only FortiOS advisor: system health (CPU/memory/disk usage, ASIC/NPU load, HA mode and primary-unit status) plus policy audit (syntax validity, duplicate policies, IPS signature version). HTTP GET only across 5 endpoints; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'FortiOS device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 8.0.0)', default: '8.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const base = apiBaseUrl(args.host);
        const get = (path: string) => httpJson(`${base}${path}`, { headers: { Authorization: `Basic ${auth}` }, tlsSkipVerify: true });
        const [statusRes, npuRes, haRes, policyRes, ipsRes] = await Promise.all([
          get('/api/v2/monitor/system/status'),
          get('/api/v2/monitor/system/npu-stats'),
          get('/api/v2/cmdb/system/ha-setting'),
          get('/api/v2/cmdb/firewall/policy'),
          get('/api/v2/cmdb/ips/sensor'),
        ]);
        for (const r of [statusRes, npuRes, haRes, policyRes, ipsRes]) {
          if (r.status < 200 || r.status >= 300) throw new Error(`FortiOS API returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        }
        const healthState = mapFortiOSSystemHealth(statusRes.json, npuRes.json, haRes.json, 'api');
        const auditState = mapFortiOSPolicyAudit(policyRes.json, ipsRes.json, 'api');
        const healthEvaluation = evaluateSpec(fortios_system_health_baseline, toObservedRecord(healthState));
        const auditEvaluation = evaluateSpec(fortios_policy_audit_baseline, toObservedRecord(auditState));
        return { product: 'FORTIOS_ADVANCED', device: args.host, evaluations: [healthEvaluation, auditEvaluation], timestamp };
      } catch (err) {
        return { product: 'FORTIOS_ADVANCED', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  },
  'sangfor_advisor_cisco_iosxe': {
    description: 'Read-only self-assessment advisor for Cisco IOS-XE routers/switches (interfaces, routing, ACLs). RESTCONF GET only; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Cisco device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 17.0.0)', default: '17.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const { status, json, text } = await httpJson(`${apiBaseUrl(args.host)}/restconf/data/ietf-interfaces:interfaces`, {
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' },
          tlsSkipVerify: true,
        });
        if (status < 200 || status >= 300) throw new Error(`Cisco RESTCONF API returned HTTP ${status}: ${text.slice(0, 200)}`);
        const configState = mapCiscoConfigState(json, 'api');
        const evaluation = evaluateSpec(cisco_interface_baseline, toObservedRecord(configState));
        return { product: 'CISCO_IOSXE', device: args.host, evaluation, timestamp };
      } catch (err) {
        return { product: 'CISCO_IOSXE', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  },
  'sangfor_advisor_cisco_iosxe_advanced': {
    description: 'Advanced read-only Cisco IOS-XE advisor: system health (per-core CPU average, memory usage, interface down count, VRF count) plus policy audit (zone-pair policy count, ACL rule count, SNORT signature version/inspection status). RESTCONF GET only across 7 endpoints; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Cisco device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 17.0.0)', default: '17.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const base = apiBaseUrl(args.host);
        const get = (path: string) => httpJson(`${base}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' }, tlsSkipVerify: true });
        const [cpuRes, memRes, ifaceRes, vrfRes, zonePolicyRes, aclRes, snortRes] = await Promise.all([
          get('/restconf/data/Cisco-IOS-XE-utilization:system'),
          get('/restconf/data/Cisco-IOS-XE-memory:memory'),
          get('/restconf/data/ietf-interfaces:interfaces-state'),
          get('/restconf/data/ietf-routing:routing'),
          get('/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair'),
          get('/restconf/data/Cisco-IOS-XE-acl:ip'),
          get('/restconf/data/Cisco-IOS-XE-snort:snort'),
        ]);
        for (const r of [cpuRes, memRes, ifaceRes, vrfRes, zonePolicyRes, aclRes, snortRes]) {
          if (r.status < 200 || r.status >= 300) throw new Error(`Cisco RESTCONF API returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        }
        const healthState = mapCiscoSystemHealth(cpuRes.json, memRes.json, ifaceRes.json, vrfRes.json, 'api');
        const auditState = mapCiscoPolicyAudit(zonePolicyRes.json, aclRes.json, snortRes.json, 'api');
        const healthEvaluation = evaluateSpec(cisco_system_health_baseline, toObservedRecord(healthState));
        const auditEvaluation = evaluateSpec(cisco_policy_audit_baseline, toObservedRecord(auditState));
        return { product: 'CISCO_IOSXE_ADVANCED', device: args.host, evaluations: [healthEvaluation, auditEvaluation], timestamp };
      } catch (err) {
        return { product: 'CISCO_IOSXE_ADVANCED', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  },
  'sangfor_collect_device_config': {
    description: 'Advisory: map a captured device XHR pool file (from scripts/device-collect.ts) into a provenance-carrying ConfigState, evaluate it against the IntendedSpec, and render the Korean advisory report. Read-only; live capture is NOT performed here (VPN + interactive session required — see docs/DEVICE_DIAGNOSIS_RUNBOOK.md).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, poolPath: { type: 'string' }, docxPath: { type: 'string' }, live: { type: 'boolean' } }, required: ['product', 'version', 'poolPath'] },
    handler: (args: { product: string; version: string; poolPath: string; docxPath?: string; live?: boolean }) => {
      if (args.live) return { error: 'live capture is not available from this tool: it needs VPN + an interactive browser session. Run scripts/device-collect.ts per docs/DEVICE_DIAGNOSIS_RUNBOOK.md, then pass the pool file here.' };
      const norm = normalizeProduct(args.product);
      if (norm !== 'ENDPOINT_SECURE' && norm !== 'CYBER_COMMAND') {
        return { error: `no pool mapper for ${args.product} yet (EPP and CC only). IAG mappers land with the M3 campaign — fabricating one without captured data is forbidden.` };
      }
      // A5 (issue #23): record the load this collection run put on the device —
      // the envelope rides the tool result into the run ledger on every mapped
      // outcome, refusals included, so collection cost is never invisible.
      const collectStartedAt = Date.now();
      const pool = JSON.parse(readFileSync(args.poolPath, 'utf8'));
      // Issue #23 step 2/3: the call site owns the collection context, so it stamps
      // the firmware version into every fact's provenance envelope here.
      const mapperOptions = { firmwareVersion: args.version };
      const mapped = norm === 'ENDPOINT_SECURE' ? mapEppPoolToConfigState(pool, mapperOptions) : mapCcPoolToConfigState(pool, mapperOptions);
      const collectionLoad = { apiCallCount: mapped.endpointsCaptured, collectDurationMs: Date.now() - collectStartedAt };
      const spec = loadSpec(norm, args.version);
      if (!spec) return { error: `no IntendedSpec for ${norm} ${args.version}. Coverage: ${JSON.stringify(listSpecCoverage())}`, collectionLoad };
      const result = evaluateSpec(spec, mapped.observed);
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { mapped: { endpointsCaptured: mapped.endpointsCaptured, mappedKeys: mapped.mappedKeys }, collectionLoad, result, report, ...(docx ? { docx } : {}) };
    }
  },
  'sangfor_chronicle_diff': {
    description: 'Read-only: latest (or span) semantic config diff for a device from the local Config Chronicle (content-addressed snapshot DAG, issue #23). Returns head hash, parent link and the write-time diff; unknown device → error, never a fabricated diff.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, dir: { type: 'string' }, fromHash: { type: 'string' }, toHash: { type: 'string' } }, required: ['deviceId'] },
    handler: (args: { deviceId: string; dir?: string; fromHash?: string; toHash?: string }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      const head = getChronicleHead(args.deviceId, dir);
      if (!head) return { error: `no chronicle chain for device "${args.deviceId}" — nothing has been recorded` };
      const diff = getChronicleDiff(args.deviceId, dir, { fromHash: args.fromHash, toHash: args.toHash });
      return { deviceId: args.deviceId, headHash: head.hash, parentHash: head.parentHash, capturedAt: head.capturedAt, diff };
    }
  },
  'sangfor_drift_findings': {
    description: 'Read-only: unapproved-drift findings for a device — chronicle diffs joined against caller-supplied change approvals (dependency-injected; this tool never writes). A diff whose capture time falls inside an approval window produces no finding.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, dir: { type: 'string' }, approvals: { type: 'array', items: { type: 'object', properties: { changeTicketId: { type: 'string' }, deviceId: { type: 'string' }, approvedAt: { type: 'string' }, windowStartAt: { type: 'string' }, windowEndAt: { type: 'string' } }, required: ['changeTicketId', 'deviceId', 'approvedAt'] } } }, required: ['deviceId'] },
    handler: (args: { deviceId: string; dir?: string; approvals?: Array<{ changeTicketId: string; deviceId: string; approvedAt: string; windowStartAt?: string; windowEndAt?: string }> }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      const findings = findUnapprovedDrift({ deviceId: args.deviceId, dir, approvals: args.approvals ?? [] });
      return { deviceId: args.deviceId, approvalsSupplied: (args.approvals ?? []).length, findings };
    }
  },
  'sangfor_snapshot_query': {
    description: 'Read-only: point-in-time query over local Config Chronicle chains — "which devices satisfy <key op value> (optionally as of a past timestamp)". Devices without an eligible snapshot are reported under noData, never matched; an empty chronicle dir is an error, never an empty fabricated answer.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, where: { type: 'object', properties: { key: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'lt', 'gte', 'exists'] }, value: {} }, required: ['key', 'op'] }, asOf: { type: 'string' } }, required: ['where'] },
    handler: (args: { dir?: string; where: { key: string; op: 'eq' | 'neq' | 'lt' | 'gte' | 'exists'; value?: unknown }; asOf?: string }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      let deviceIds: string[] = [];
      try {
        deviceIds = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
      } catch {
        return { error: `chronicle dir unreadable: ${dir}` };
      }
      if (deviceIds.length === 0) return { error: `no chronicle chains under ${dir} — nothing has been recorded` };
      const chains = Object.fromEntries(deviceIds.map((deviceId) => [
        deviceId,
        listChronicleSnapshots(deviceId, dir).map((snapshot) => ({ capturedAt: snapshot.capturedAt, observed: snapshot.observed })),
      ]));
      return queryDevices({ chains, where: { key: args.where.key, op: args.where.op, value: args.where.value ?? null }, ...(args.asOf ? { asOf: args.asOf } : {}) });
    }
  },
  'sangfor_report_chain_verify': {
    description: 'Read-only: verify the hash-chained EngineerReport ledger in a directory — detects edited verdicts, deleted records, and unparseable lines. Reports the honest chain state; it never repairs anything.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    handler: (args: { dir?: string }) => verifyReportChain(args.dir ?? resolveRepoData('data/engineer-reports', 'SANGFOR_ENGINEER_REPORT_DIR'))
  },
  'sangfor_scorecard_tier': {
    description: 'Read-only advisory: compute a device acquisition-quality tier (bronze/silver/gold with dwell hysteresis) from caller-supplied metrics and thresholds, plus which autonomy capabilities that tier permits (auto-close and cross-device specs are gold-only, fail-closed).',
    inputSchema: { type: 'object', properties: { metrics: { type: 'object' }, thresholds: { type: 'object' }, previous: { type: 'object' } }, required: ['metrics', 'thresholds'] },
    handler: (args: { metrics: ScorecardMetrics; thresholds: TierThresholds; previous?: { tier: 'bronze' | 'silver' | 'gold'; sinceAt: string; candidateTier: 'bronze' | 'silver' | 'gold'; candidateSinceAt: string } }) => {
      const result = computeTier(args.metrics, args.thresholds, args.previous);
      return {
        ...result,
        autonomy: {
          'auto-close': autonomyAllowed(result.tier, 'auto-close'),
          'cross-device-spec': autonomyAllowed(result.tier, 'cross-device-spec'),
        },
      };
    }
  },
  'sangfor_capability_safety': {
    description: 'Report capability safety_class and maturity from physically separated safety/competency files. Default is human_only; autoAllowed is true only for explicit auto_allowed entries, and fieldVerifiedAutoAllowed additionally requires maturity=field_verified.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, capabilityId: { type: 'string' } } },
    handler: (args: { product?: string; capabilityId?: string }) => args.product && args.capabilityId
      ? getCapabilitySafety(args.product, args.capabilityId)
      : { capabilities: listCapabilitySafety() }
  },
  'sangfor_field_engineer_coverage': {
    description: 'Honest "field-engineer replacement rate" from the WorkAtom taxonomy: counts ONLY automatable AND field_verified atoms whose covering tool is ADVERTISED by the active tool profile and whose evidence is a real confined artifact. Human-only atoms never count. Any unverifiable claim refuses the whole report (ok=false + typed violations) instead of returning a quietly wrong rate. groundedToolCount reports how many advertised tools the grounding used. Optional cursor/limit page the atoms list; omit both for the full list.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => {
      // Ground on what this server ADVERTISES, not on the internal tool map: a
      // tool hidden by the active profile cannot be called by any client here, so
      // certifying a replacement against it would claim a capability nobody can
      // reach. The rest of the context is the one repo-anchored factory both
      // surfaces share, so the console can never disagree with this rate.
      const advertised = listToolsForProfile().map((t) => t.name);
      const groundedToolCount = advertised.length;
      const built = buildRepoCoverageContext(advertised);
      if (!built.ok) return { ok: false, groundedToolCount, violations: built.violations };

      const result = computeReplacementCoverage(built.context);
      if (!result.ok) return { ok: false, groundedToolCount, violations: result.violations };

      const loaded = loadWorkAtomCatalog(built.context.catalogRoot);
      if (!loaded.ok) return { ok: false, groundedToolCount, violations: loaded.violations };
      // coverage is computed over ALL atoms regardless of pagination — only the
      // returned `atoms` listing is windowed. Sort by id so a cursor always
      // resumes at the same row (loader order is directory order, not stable).
      const sortedAtoms = [...loaded.atoms].sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, groundedToolCount, coverage: result.report, ...paginateOptionalField(sortedAtoms, args, (a) => a.id, 'atoms') };
    }
  },
  'sangfor_suggest_rca': {
    description: 'Suggest ranked root-cause candidates + concrete check steps for a symptom (read-only advisory). Grounded in product manuals; returns empty (no fabrication) for unrelated symptoms.',
    inputSchema: { type: 'object', properties: { symptom: { type: 'string' }, product: { type: 'string' } }, required: ['symptom'] },
    handler: (args: { symptom: string; product?: string }) => suggestRca(args.symptom, args.product)
  },
  'sangfor_recommend_sizing': {
    description: 'Advisory sizing tier (small/medium/large/xlarge) from the primary scale driver (IAG=users, EPP=endpoints, HCI=vmCount, CC=eps, NGFW=Mbps). Never invents an exact model/BOM — defers to official Sizing Guide + SE validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, concurrentUsers: { type: 'number' }, endpoints: { type: 'number' }, vmCount: { type: 'number' }, eventsPerSecond: { type: 'number' }, throughputMbps: { type: 'number' } }, required: ['product'] },
    handler: (args: { product: string } & SizingInput) => recommendSizing(args.product, args)
  },
  'sangfor_pm_create_engagement': {
    description: 'PM: create an engagement (customer project). Local PM-ledger write; requires explicit user intent (customer and product), recorded as a hash-chained audit event.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string' }, product: { type: 'string' } }, required: ['customer', 'product'] },
    handler: (args: { customer: string; product: string }) => pmStore.createEngagement(args)
  },
  'sangfor_pm_add_work_item': {
    description: 'PM: add a work item to an engagement. Local PM-ledger write; requires explicit engagementId, recorded as a hash-chained audit event.',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' }, title: { type: 'string' }, deviceId: { type: 'string' }, assignee: { type: 'string' } }, required: ['engagementId', 'title'] },
    handler: (args: { engagementId: string; title: string; deviceId?: string; assignee?: string }) => pmStore.addWorkItem(args.engagementId, args)
  },
  'sangfor_pm_status': {
    description: 'PM: status rollup for an engagement + current device occupancy (who holds which device).',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' } }, required: ['engagementId'] },
    handler: (args: { engagementId: string }) => ({ rollup: pmStore.statusRollup(args.engagementId), deviceOccupancy: pmStore.deviceOccupancy(), chainOk: pmStore.verifyEventChain(args.engagementId) })
  },
  'sangfor_pm_events': {
    description: 'PM (read-only): the tamper-evident event timeline for an engagement + chain integrity status. Unknown engagement errors (no fake empty timeline). Optional cursor/limit page the event timeline; omit both for the full timeline (default, backward-compatible).',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['engagementId'] },
    handler: (args: { engagementId: string; cursor?: string; limit?: number }) => {
      if (!pmStore.getEngagement(args.engagementId)) throw new Error(`Engagement not found: ${args.engagementId}`);
      // chainOk verifies the FULL chain regardless of pagination — only the
      // returned `events` listing is windowed.
      return {
        ...paginateOptionalField(pmStore.getEvents(args.engagementId), args, (e) => e.id, 'events'),
        chainOk: pmStore.verifyEventChain(args.engagementId),
      };
    }
  },
  'sangfor_pm_report': {
    description: 'PM (read-only): a citable Korean progress report derived ONLY from recorded events (rollup %, work items, event timeline, audit-chain-broken banner if tampered). No unrecorded-progress guessing.',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' } }, required: ['engagementId'] },
    handler: (args: { engagementId: string }) => ({ report: pmStore.renderStatusReport(args.engagementId) })
  },
  'sangfor_integration_guide': {
    description: 'Standard integration guide (AD/LDAP, RADIUS, SIEM/syslog): cited prerequisites → steps → validation → pitfalls for the human to follow. Unknown integration type returns an error (no fabrication). No type → list supported types.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'LDAP/AD, RADIUS, or SIEM/syslog' }, product: { type: 'string' } } },
    handler: (args: { type?: string; product?: string }) => {
      if (!args.type) return { supported: listIntegrationTypes() };
      const g = generateIntegrationGuide(args.type, args.product);
      return g ?? { error: `Unknown integration type "${args.type}". Supported: ${listIntegrationTypes().join(', ')}` };
    }
  },
  'sangfor_check_version': {
    description: 'Upgrade advisory: check a device version against the collected Version Requirements (min/recommended) and return meetsMin/atRecommended + cited advice. Returns null-style error for unknown devices (no fabricated compatibility claim). No args → list known requirements.',
    inputSchema: { type: 'object', properties: { device: { type: 'string' }, currentVersion: { type: 'string' } } },
    handler: (args: { device?: string; currentVersion?: string }) => {
      if (!args.device || !args.currentVersion) return { requirements: loadVersionRequirements() };
      const r = checkVersionRequirement(args.device, args.currentVersion);
      return r ?? { error: `No version requirement on file for device "${args.device}". Known: ${loadVersionRequirements().map((x) => x.device).join(', ')}` };
    }
  },
  'sangfor_pm_acquire_device': {
    description: 'PM safety: acquire an exclusive device lock for an engagement before any device work. Blocks if another engagement holds it (prevents cross-engagement changes on a shared lab device).',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, engagementId: { type: 'string' }, holder: { type: 'string' } }, required: ['deviceId', 'engagementId', 'holder'] },
    handler: (args: { deviceId: string; engagementId: string; holder: string }) => pmStore.acquireDevice(args.deviceId, args.engagementId, args.holder)
  },
  'sangfor_pm_release_device': {
    description: 'PM safety: release a device lock held by an engagement (records a device_released audit event). Returns false if the engagement does not hold the lock.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, engagementId: { type: 'string' } }, required: ['deviceId', 'engagementId'] },
    handler: (args: { deviceId: string; engagementId: string }) => ({ released: pmStore.releaseDevice(args.deviceId, args.engagementId) })
  },
  'sangfor_list_learning_strategies': {
    description: 'List local learning strategy revisions with exact filters and cursor pagination.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      strategyId: { type: 'string' }, vendor: { type: 'string', enum: ['SANGFOR', 'FORTINET', 'CISCO'] },
      product: { type: 'string' }, firmwareVersion: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'] },
      cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } },
    handler: (args: unknown) => currentLearningService().list(learningArgs(args, ['strategyId', 'vendor', 'product', 'firmwareVersion', 'status', 'cursor', 'limit'])),
  },
  'sangfor_resolve_learning_strategy': {
    description: 'Resolve one exact eligible learning strategy; returns honest miss, canary, drift, or ambiguity reasons.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['scope', 'context'], properties: {
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      context: { type: 'object', additionalProperties: false, required: ['registryDigest', 'versionTruthRecord'], properties: { registryDigest: { type: 'string' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, deviceScope: { type: 'string' }, environment: { type: 'string', enum: ['lab', 'poc', 'customer', 'production'] } } },
    } },
    handler: (args: unknown) => { const input = learningArgs(args, ['scope', 'context']); return currentLearningService().resolve(input.scope, input.context); },
  },
  'sangfor_attach_observation_session': {
    description: 'WRITE: attach to one exact loopback CDP page owned by the observer profile registry.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['product', 'expectedOrigin', 'cdpPort', 'firmwareTruthId'], properties: { product: { type: 'string' }, expectedOrigin: { type: 'string' }, cdpPort: { type: 'integer', minimum: 1, maximum: 65535 }, firmwareTruthId: { type: 'string' } } },
    handler: (args: unknown) => observerManager().attach(learningArgs(args, ['product', 'expectedOrigin', 'cdpPort', 'firmwareTruthId']) as any),
  },
  'sangfor_manage_learning_capture': {
    description: 'WRITE: start or stop a passive observation capture; stop promotes one encrypted capture-bundle.v1.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['start', 'stop'] }, sessionHandle: { type: 'string' }, captureId: { type: 'string' }, durationMs: { type: 'integer', minimum: 0, maximum: 30000 }, firmwareVersion: { type: 'string' } } },
    handler: async (args: unknown) => {
      const input = learningArgs(args, ['action', 'sessionHandle', 'captureId', 'durationMs', 'firmwareVersion']);
      if (input.action === 'start') {
        if (typeof input.sessionHandle !== 'string' || !observerManager().get(input.sessionHandle)) throw new Error('OBSERVER_SESSION_UNAVAILABLE: exact sessionHandle is required.');
        const captureId = randomBytes(16).toString('hex');
        pendingLearningCaptures.set(captureId, { sessionHandle: input.sessionHandle, durationMs: input.durationMs, firmwareVersion: input.firmwareVersion });
        return { captureId, status: 'started' };
      }
      if (input.action !== 'stop' || typeof input.captureId !== 'string') throw new Error('INVALID_INPUT: action stop requires captureId.');
      const pending = pendingLearningCaptures.get(input.captureId);
      if (!pending) throw new Error('CAPTURE_NOT_FOUND: captureId is missing or already consumed.');
      const summary = await observerManager().capture({ ...pending, capturesDir: resolveRepoData('data/captures'), stagingRoot: resolveRepoData('data/runtime/learning-captures'), keyring: captureKeyringFromEnv() });
      pendingLearningCaptures.delete(input.captureId);
      return { captureId: input.captureId, status: 'stopped', bundle: summary };
    },
  },
  'sangfor_collect_facts': {
    description: 'WRITE: collect requested facts through an exact learning strategy and return complete/partial/conflict/unavailable observations.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['scope', 'context', 'factIds'], properties: {
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      context: { type: 'object', additionalProperties: false, required: ['registryDigest', 'versionTruthRecord'], properties: { registryDigest: { type: 'string' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, deviceScope: { type: 'string' }, environment: { type: 'string', enum: ['lab', 'poc', 'customer', 'production'] } } },
      factIds: { type: 'array', minItems: 1, items: { type: 'string' } }, allowCanary: { type: 'boolean', default: false },
      methodResults: { type: 'array', items: { type: 'object' } },
    } },
    handler: (args: unknown) => currentLearningService().collectFacts(learningArgs(args, ['scope', 'context', 'factIds', 'allowCanary', 'methodResults']) as any),
  },
  'sangfor_research_learning_strategy': {
    description: 'WRITE: create an immutable draft from supplied official citation and optional capture evidence.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'officialCitation', 'pageVerified'], properties: {
      strategyId: { type: 'string' }, vendor: { type: 'string', enum: ['SANGFOR', 'FORTINET', 'CISCO'] },
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      registryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, officialCitation: { type: 'string' }, pageVerified: { type: 'boolean' }, captureEvidenceFile: { type: 'string' }, methods: { type: 'array', items: { type: 'string', enum: ['LM-01', 'LM-02', 'LM-03', 'LM-04', 'LM-05', 'LM-06', 'LM-07', 'LM-08'] } },
    } },
    handler: (args: unknown) => currentLearningService().research(learningArgs(args, ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'productVariant', 'officialCitation', 'pageVerified', 'captureEvidenceFile', 'methods']) as any),
  },
  'sangfor_validate_learning_strategy': {
    description: 'WRITE: validate exact revision evidence and report eligible next states without promotion.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'revisionId'], properties: { strategyId: { type: 'string' }, revisionId: { type: 'string' }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    handler: (args: unknown) => currentLearningService().validate(learningArgs(args, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest']) as any),
  },
  'sangfor_promote_learning_strategy': {
    description: 'WRITE: promote an immutable revision through a signed, action-bound, single-use lifecycle approval.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'revisionId', 'toState', 'approvalPayload', 'approvalToken', 'evidenceRoot'], properties: {
      strategyId: { type: 'string' }, revisionId: { type: 'string' }, toState: { type: 'string', enum: ['researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'] }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string' }, approvalToken: { type: 'string', pattern: '^[a-f0-9]{64}$' }, evidenceRoot: { type: 'string' },
      approvalPayload: { type: 'object', additionalProperties: false, required: ['entityType', 'entityId', 'revisionId', 'contentHash', 'fromState', 'toState', 'evidenceFile', 'evidenceDigest', 'nonce', 'expiresAt', 'authorityEpoch'], properties: { entityType: { type: 'string' }, entityId: { type: 'string' }, revisionId: { type: 'string' }, contentHash: { type: 'string' }, fromState: { type: 'string' }, toState: { type: 'string' }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string' }, nonce: { type: 'string' }, expiresAt: { type: 'string' }, authorityEpoch: { type: 'integer', minimum: 0 } } },
    } },
    handler: (args: unknown) => currentLearningService().promote(learningArgs(args, ['strategyId', 'revisionId', 'toState', 'evidenceFile', 'evidenceDigest', 'approvalPayload', 'approvalToken', 'evidenceRoot']) as any),
  },

  // ── 플레이북 (Control Tower :3700 프록시) ─────────────────────────────────
  // 리비전 승인/반려는 의도적으로 노출하지 않는다 — 승인은 타워 UI의 사람 행위다.
  // 실행 중 write 블록은 여전히 타워 승인 큐에서 멈춘다(도구가 승인을 대신하지 않는다).
  'sangfor_playbook_list': {
    description: 'Read-only: list Control Tower playbooks with their active revision and last run status.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => new TowerClient().request('GET', '/api/playbooks')
  },
  'sangfor_playbook_get': {
    description: 'Read-only: get one playbook with all revisions and blocks.',
    inputSchema: { type: 'object', properties: { playbookId: { type: 'string' } }, required: ['playbookId'] },
    handler: ({ playbookId }: { playbookId: string }) =>
      new TowerClient().request('GET', `/api/playbooks/${encodeURIComponent(playbookId)}`)
  },
  'sangfor_playbook_run_status': {
    description: 'Read-only: get a playbook run — derived status, per-block run ids and submitted analyses.',
    inputSchema: { type: 'object', properties: { playbookRunId: { type: 'string' } }, required: ['playbookRunId'] },
    handler: ({ playbookRunId }: { playbookRunId: string }) =>
      new TowerClient().request('GET', `/api/playbook-runs/${encodeURIComponent(playbookRunId)}`)
  },
  'sangfor_playbook_agent_tasks': {
    description: 'Read-only: list the Control Tower agent task queue (assemble/revise/analyze requests raised from the UI). Poll this to pick up work.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'cancelled'], default: 'open' } } },
    handler: ({ status }: { status?: string }) =>
      new TowerClient().request('GET', `/api/agent-tasks?status=${encodeURIComponent(status ?? 'open')}`)
  },
  'sangfor_playbook_create': {
    description: 'Write (tower-local): create a playbook as revision 1 in draft. Blocks are tool blocks (toolId/args/deviceId) plus at most one report block; args may use {{blocks.<id>.result.<path>}} templates. A human must approve the revision in the tower UI before it can run. Running it requires explicit human approval in the tower UI.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, goal: { type: 'string' }, authoredBy: { type: 'string' },
        note: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' }, description: '[{id,type:"tool"|"report",title?,toolId?,args?,deviceId?}]' },
      },
      required: ['name', 'goal', 'authoredBy', 'blocks'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request('POST', '/api/playbooks', {
      name: args.name, goal: args.goal, authoredBy: args.authoredBy, note: args.note, blocks: args.blocks,
    })
  },
  'sangfor_playbook_add_revision': {
    description: 'Write (tower-local): append a new draft revision to an existing playbook (the revise loop). Needs human approval before it becomes the active revision. Becoming active requires explicit human approval in the tower UI.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'string' }, authoredBy: { type: 'string' }, note: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' } },
      },
      required: ['playbookId', 'authoredBy', 'blocks'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'POST', `/api/playbooks/${encodeURIComponent(String(args.playbookId))}/revisions`,
      { authoredBy: args.authoredBy, note: args.note, blocks: args.blocks },
    )
  },
  'sangfor_playbook_execute': {
    description: 'Write: run the approved revision of a playbook block by block. Read-only blocks run immediately; the first write/destructive block stops the run as pending_approval in the tower queue (no device mutation without a separate human approval).',
    inputSchema: { type: 'object', properties: { playbookId: { type: 'string' } }, required: ['playbookId'] },
    handler: ({ playbookId }: { playbookId: string }) => new TowerClient().request(
      'POST', `/api/playbooks/${encodeURIComponent(playbookId)}/execute`, {}, 180_000,
    )
  },
  'sangfor_playbook_submit_analysis': {
    description: 'Write (tower-local): submit an append-only AI analysis for a playbook run — observations with evidence run ids plus follow-up proposals. The human accepts or dismisses each item in the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookRunId: { type: 'string' }, playbookId: { type: 'string' },
        summary: { type: 'string' }, authoredBy: { type: 'string' },
        improvements: { type: 'array', items: { type: 'object' }, description: '[{observation,recommendation,evidenceRunId?}]' },
        proposals: { type: 'array', items: { type: 'object' }, description: '[{action,rationale,linkedPlaybookId?}]' },
      },
      required: ['playbookRunId', 'playbookId', 'summary', 'authoredBy'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'POST', `/api/playbook-runs/${encodeURIComponent(String(args.playbookRunId))}/analysis`,
      {
        playbookId: args.playbookId, summary: args.summary, authoredBy: args.authoredBy,
        improvements: args.improvements ?? [], proposals: args.proposals ?? [],
      },
    )
  },
  'sangfor_playbook_close_agent_task': {
    description: 'Write (tower-local): close an agent task as done, recording what was produced (playbookId/rev/analysisId/note).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        result: { type: 'object', description: '{playbookId?,rev?,analysisId?,note?}' },
      },
      required: ['taskId'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'PATCH', `/api/agent-tasks/${encodeURIComponent(String(args.taskId))}`,
      { result: args.result ?? {} },
    )
  },
  'sangfor_agent_manifest': {
    description: 'Agent self-onboarding manifest: recommended first calls, standard tool groups, tool exposure profile, and the read-only-by-default safety posture. Call this first to discover the server. Read-only; never mutates.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      server: 'sangfor-engineer-mcp',
      posture: 'read-only by default; device/external writes require explicit signed approval + SANGFOR_ALLOW_REAL_EXECUTION',
      recommended_first_calls: [
        'sangfor_products',
        'sangfor_capabilities',
        'sangfor_list_spec_coverage',
        'sangfor_search_manuals',
        'sangfor_analyze_project',
      ],
      standard_tools: [
        'sangfor_evaluate_config', 'sangfor_suggest_rca', 'sangfor_recommend_sizing', 'sangfor_check_version',
        'sangfor_analyze_project', 'sangfor_generate_config_plan', 'sangfor_generate_evidence_report',
        'sangfor_search_manuals', 'sangfor_search_wiki', 'sangfor_rag_search',
        'sangfor_advisor_fortios', 'sangfor_advisor_cisco_iosxe',
        'sangfor_hci_inventory', 'sangfor_hci_health_report',
        'sangfor_playbook_list', 'sangfor_pm_status',
      ],
      mutation_gating: 'Tools that change devices/external systems are gated: they require explicit user intent, a signed action-bound single-use approval, and SANGFOR_ALLOW_REAL_EXECUTION (production also SANGFOR_ALLOW_PRODUCTION_EXECUTION). Dry-run is the default.',
      activeProfile: activeToolProfile(),
      toolCountByProfile: Object.fromEntries(TOOL_PROFILES.map((p) => [p, listToolsForProfile(p).length])),
      profileDescriptions: PROFILE_DESCRIPTIONS,
      quickstart: {
        // Not published to a public registry (package.json is private:true) —
        // "npx sangfor-engineer-mcp" would not resolve. Real path: clone the
        // repo, `pnpm install` once, then run the bin script directly.
        stdio: 'node bin/sangfor-engineer-mcp.mjs (after: pnpm install, from a local clone)',
        setProfileExample: 'SANGFOR_TOOL_PROFILE=advisor node bin/sangfor-engineer-mcp.mjs',
      },
    })
  },
  'sangfor_session_report': {
    description: 'One-click session/change-run work report: overview, step timeline, read-back/verification results, hash-chain integrity (via AuditLedger.verify), and related evidence files, built from the data/evidence change-run ledger. Omit runId to list available change-run ids (read-only). Pass save:true to also write the Markdown report under data/evidence/reports/<runId>.md.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Change-run id (ledger file basename under data/evidence/change-runs/). Omit to list available ids.' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Default markdown.' },
        save: { type: 'boolean', description: 'Also write the Markdown report to data/evidence/reports/<runId>.md. Default false.' },
      },
    },
    handler: (args: { runId?: string; format?: 'markdown' | 'json'; save?: boolean }) => {
      if (!args.runId) return { availableRunIds: listChangeRunIds() };
      if (!isSafeRunId(args.runId)) return { error: `INVALID_RUN_ID: "${args.runId}" is not a safe path segment.` };
      const { markdown, json } = buildChangeRunReport({ runId: args.runId });
      const format = args.format ?? 'markdown';
      const report = format === 'json' ? json : markdown;
      if (!args.save) return { format, report };
      const savedPath = join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'reports', `${args.runId}.md`);
      writeFileAtomicSync(savedPath, markdown);
      return { format, report, savedPath };
    },
  },
  'sangfor_search_gaps': {
    description: 'Read-only: list recorded search gaps — sangfor_rag_search calls that returned 0 hits or a top score below SANGFOR_RAG_WEAK_THRESHOLD (default 0.15). Feeds what to ingest/author next. Optional cursor/limit page the list; omit both for the full list (default, backward-compatible). Disable capture entirely with SANGFOR_SEARCH_GAP_CAPTURE=0.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => paginateOptionalField(readSearchGaps(), args, (g) => g.id, 'gaps'),
  },
  'sangfor_loop_status': {
    description: 'Read-only: loop-graph runtime status — the declared pipeline graph summary (data/graph/pipeline.json), per-edge cursors and pending event counts, human-approval gate nodes, and the most recent loop-ledger entries. The loop engine itself only runs read/collect/eval work; gate nodes are never auto-executed. Design: docs/plans/designs/001-loop-graph-runtime.md.',
    inputSchema: { type: 'object', properties: { tail: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent ledger entries to include (default 20).' } } },
    handler: (args: { tail?: number }) => buildLoopStatus({ tail: args.tail }),
  },
  'sangfor_safety_selftest': {
    description: 'Read-only self-test: proves the fail-closed safety gates actually refuse an unapproved action — the operator real-execution gate (verified in a clean-env child process, no device/network contact), the http-bridge destructive-tool guard, a forged HMAC approval-signature rejection, and single-use nonce replay rejection. allPass means every EXECUTED check passed; a check only falls back to outcome:"skipped" (never counted toward allPass) if its subprocess could not be run at all (spawn failure/timeout) — skippedCount reports how many that applies to.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => runSafetySelftest(),
  },
  'sangfor_capabilities': {
    description: 'Discovery: server capabilities — tool categories and counts, supported vendors/products, execution posture, and which write paths are gated. Read-only; never mutates.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const all = listTools();
      const byCategory: Record<string, number> = {};
      for (const t of all) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
      return {
        server: 'sangfor-engineer-mcp',
        toolCount: all.length,
        categories: byCategory,
        vendors: ['SANGFOR', 'FORTIOS', 'CISCO_IOSXE'],
        priorityProducts: PRODUCTS,
        executionPosture: {
          default: 'dry-run / read-only',
          liveWriteRequires: ['SANGFOR_ALLOW_REAL_EXECUTION', 'signed action-bound single-use approval'],
          productionAlsoRequires: ['SANGFOR_ALLOW_PRODUCTION_EXECUTION'],
          indeterminateIsNeverPass: true,
        },
        discoveryTools: ['sangfor_agent_manifest', 'sangfor_capabilities'],
      };
    }
  },
  'sangfor_engagement_scope': {
    description: 'Read-only: whether a customer-engagement data scope is active (SANGFOR_ENGAGEMENT_ID) and which data roots it isolates — the run ledger, search-gap feedback file, and saved session reports. Inactive (the default) means every deployment shares the same unscoped repo data roots. An invalid SANGFOR_ENGAGEMENT_ID throws rather than silently falling back.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const engagementId = activeEngagementId();
      const repoRoot = resolveRepoData('.');
      const toRel = (abs: string) => relative(repoRoot, abs) || '.';
      const runsRoot = resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
      const reportsRoot = join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'reports');
      return {
        active: engagementId !== undefined,
        engagementId,
        scopedRoots: [
          { name: 'runs', path: toRel(runsRoot) },
          { name: 'search-gaps-feedback', path: toRel(feedbackRoot()) },
          { name: 'session-reports', path: toRel(reportsRoot) },
        ],
      };
    },
  },
  'sangfor_audit_frameworks': {
    description: 'Read-only: list registered customer audit-checklist frameworks (e.g. a customer\'s security-audit master table promoted to data) — frameworkId, title, version, and item count. Use with sangfor_audit_checklist / sangfor_audit_gap_report.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => listAuditFrameworkSummaries(),
  },
  'sangfor_audit_checklist': {
    description: 'Read-only: list checklist items for one audit framework, optionally filtered by group/product/priority/owner. Sorted by itemId. Optional cursor/limit page the result; omit both for the full filtered list (default, backward-compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Framework id from sangfor_audit_frameworks, e.g. "hyundai-supplier-2026".' },
        group: { type: 'string', enum: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'], description: 'Filter to one audit group.' },
        product: { type: 'string', description: 'Filter to items whose products include this @sangfor/shared ProductCode.' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Filter to one priority.' },
        owner: { type: 'string', enum: ['customer', 'engineer', 'vendor'], description: 'Filter to one owning role.' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['frameworkId'],
    },
    handler: (args: { frameworkId: string; group?: AuditGroup; product?: ProductCode; priority?: AuditPriority; owner?: AuditOwner; cursor?: string; limit?: number }) => {
      const framework = getAuditFramework(args.frameworkId);
      if (!framework) return { error: `UNKNOWN_FRAMEWORK: "${args.frameworkId}" is not registered. Call sangfor_audit_frameworks to see available ids.` };
      const filtered = filterChecklistItems(framework.items, {
        group: args.group,
        product: args.product,
        priority: args.priority,
        owner: args.owner,
      });
      return paginateOptionalField(filtered, args, (i) => i.itemId, 'items');
    },
  },
  'sangfor_audit_gap_report': {
    description: 'Read-only: build a gap report for an audit framework from observations you supply — {itemId, status: met|partial|gap|unknown, observed?, evidenceRefs?}. Every item in the framework is included even with no matching observation (reported as status "unknown" / verdict "미확인" — missing coverage is never hidden). missingEvidence is requiredEvidence in full when evidenceRefs is empty/omitted, and empty when any evidenceRefs are supplied (not a substring match). Returns per-item verdict (O/△/X/미확인) plus a summary {total, met, partial, gap, unknown, observedRatio (how much of the framework has been inspected), metRatio (how much of it passes)}.',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Framework id from sangfor_audit_frameworks.' },
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              status: { type: 'string', enum: ['met', 'partial', 'gap', 'unknown'] },
              observed: { type: 'string' },
              evidenceRefs: { type: 'array', items: { type: 'string' } },
            },
            required: ['itemId', 'status'],
          },
        },
      },
      required: ['frameworkId', 'observations'],
    },
    handler: (args: { frameworkId: string; observations: AuditObservation[] }) => {
      const framework = getAuditFramework(args.frameworkId);
      if (!framework) return { error: `UNKNOWN_FRAMEWORK: "${args.frameworkId}" is not registered. Call sangfor_audit_frameworks to see available ids.` };
      return computeGapReport(framework, args.observations ?? []);
    },
  },
  'sangfor_build_evidence_package': {
    description: 'Writes a local file (not a device change): assembles a customer-submission .docx evidence package via officecli (cover page, a summary table with per-verdict counts, one section per checklist item with its evidence images embedded, and — when captureRunId is given — a "증적 무결성" section reporting AuditLedger chain + per-file hash verification). observed/verdict text is used exactly as supplied, never summarized or inferred; items with no evidence file are marked "(증적 파일 없음)" (naming the expected files when any were claimed but none found) rather than silently skipped. items is shaped to accept sangfor_audit_gap_report output nearly as-is — see @sangfor/evidence gapReportItemsToEvidenceItems for the field mapping (evidenceRefs -> evidenceFiles). Auto-validates the result via officecli and returns it under validation. Defaults outputPath to the engagement-scoped evidence root under packages/<dateStamp>/. Refuses to overwrite an existing file at outputPath (OFFICE_FILE_EXISTS) unless overwrite:true is passed — a customer submission is never silently replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Optional audit framework id, shown on the cover page.' },
        title: { type: 'string', description: 'Document title, e.g. "ITAC 보안 필수사항 점검 증적 패키지".' },
        customer: { type: 'string', description: 'Customer name, shown on the cover page.' },
        dateStamp: { type: 'string', description: 'Collection/authoring date, e.g. "20260806". Also used in the default outputPath.' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              topic: { type: 'string' },
              reqIds: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', description: 'Observation status, e.g. met/partial/gap/unknown — used exactly as supplied.' },
              verdict: { type: 'string', description: 'Verdict text, e.g. O/△/X/미확인 — used exactly as supplied, not reinterpreted.' },
              observed: { type: 'string', description: 'Measured/observed text. Omit or pass "미확인" when not confirmed — never inferred.' },
              evidenceFiles: { type: 'array', items: { type: 'string' }, description: 'Local file paths of evidence images for this item. Missing/nonexistent files are reported honestly rather than embedded.' },
            },
            required: ['itemId', 'topic', 'reqIds', 'status', 'verdict'],
          },
        },
        captureRunId: { type: 'string', description: 'Optional sangfor_console_capture_evidence runId — adds a "증적 무결성" section verifying the AuditLedger chain and per-file hashes for that run.' },
        outputPath: { type: 'string', description: 'Optional output path. Defaults under the engagement-scoped evidence root at packages/<dateStamp>/.' },
        overwrite: { type: 'boolean', description: 'Default false. When outputPath already exists, the call is refused with OFFICE_FILE_EXISTS unless this is true — protects a customer submission from being silently replaced.' },
      },
      required: ['title', 'customer', 'dateStamp', 'items'],
    },
    handler: (args: { frameworkId?: string; title: string; customer: string; dateStamp: string; items: EvidencePackageItem[]; captureRunId?: string; outputPath?: string; overwrite?: boolean }) =>
      buildEvidencePackage(args),
  },
};

// Tools that change customer devices or external systems — clients MUST gate these.
// Adding a new mutator without listing it here is caught by tests/mcp-tool-annotations.
const DESTRUCTIVE_TOOLS = new Set([
  'sangfor_apply_approved_product_change',
  'sangfor_execute_console_action',
  'sangfor_execute_console_action_live',
  'sangfor_apply_wiki_update',
  'sangfor_apply_github_wiki_update',
  'sangfor_apply_obsidian_wiki_update',
  'sangfor_hci_delete_volume',
  'sangfor_iag_exception_apply',
]);

// Tools that write local server/session/dataset/artifact state (not customer devices).
const WRITE_TOOLS = new Set([
  'sangfor_pm_create_engagement', 'sangfor_pm_add_work_item', 'sangfor_pm_acquire_device', 'sangfor_pm_release_device',
  'sangfor_create_eval_case_from_feedback', 'sangfor_create_finetune_dataset', 'sangfor_create_finetune_job_spec',
  'sangfor_propose_wiki_update', 'sangfor_approve_wiki_update', 'sangfor_upsert_knowledge_card',
  'sangfor_ingest_document', 'sangfor_learn_sources', 'sangfor_import_excel_requirement_list',
  'sangfor_submit_feedback', 'sangfor_extract_lesson', 'sangfor_request_approval', 'sangfor_run_planner_eval',
  'sangfor_capture_screenshots', 'sangfor_console_capture_evidence', 'sangfor_start_operator_session', 'sangfor_kill_session',
  'sangfor_generate_all_guides', 'sangfor_generate_comprehensive_operations_guide_docx',
  'sangfor_generate_comprehensive_setting_guide_docx', 'sangfor_generate_config_plan',
  'sangfor_generate_evidence_report', 'sangfor_generate_excel_based_change_plan', 'sangfor_session_report',
  'sangfor_generate_operations_guide_docx', 'sangfor_generate_operations_guide_pptx',
  'sangfor_generate_product_change_plan', 'sangfor_generate_setting_guide_docx', 'sangfor_generate_setting_guide_pptx',
  'sangfor_build_evidence_package',
  'sangfor_hci_apply_create_volume',
  'sangfor_attach_observation_session', 'sangfor_manage_learning_capture', 'sangfor_collect_facts',
  'sangfor_research_learning_strategy', 'sangfor_validate_learning_strategy', 'sangfor_promote_learning_strategy',
  // 플레이북: 타워 상태를 바꾼다. execute는 장비 write 블록에서 승인 대기로 멈추므로
  // 그 자체는 destructive가 아니다 (장비 변경은 별도 사람 승인을 거친다).
  'sangfor_playbook_create', 'sangfor_playbook_add_revision', 'sangfor_playbook_execute',
  'sangfor_playbook_submit_analysis', 'sangfor_playbook_close_agent_task',
]);

function categoryOf(name: string): string {
  const n = name.replace(/^sangfor_/, '');
  if (DESTRUCTIVE_TOOLS.has(name)) return 'admin';
  if (n.startsWith('playbook_')) return 'playbook';
  if (n.startsWith('hci_')) return 'hci';
  if (n.startsWith('pm_')) return 'pm';
  if (/wiki/.test(n)) return 'wiki';
  if (n.startsWith('generate_') || /report|guide|excel|evidence_package/.test(n)) return 'report';
  if (/rag|search|manual|store_health|discover/.test(n)) return 'knowledge';
  if (/finetune|eval|feedback|lesson/.test(n)) return 'ml';
  if (/console|operator|session|screenshot|collect/.test(n)) return 'collect';
  return 'advisory';
}

function annotationsFor(name: string, description: string) {
  const destructive = DESTRUCTIVE_TOOLS.has(name);
  const write = destructive || WRITE_TOOLS.has(name);
  return {
    title: (description.split(/[.:—]/)[0] || name).slice(0, 60).trim(),
    readOnlyHint: !write,
    destructiveHint: destructive,
  };
}

export function getToolHandler(name: string): ToolHandler | undefined {
  return tools[name]?.handler;
}

export function listTools() {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: annotationsFor(name, tool.description),
    category: categoryOf(name),
  }));
}

// ─── Tool exposure profiles (accessibility surface, not a safety gate) ────────
// SANGFOR_TOOL_PROFILE narrows which tools a client sees/can call. It is derived
// dynamically from the SAME readOnlyHint/destructiveHint annotations every tool
// already carries (see annotationsFor above) — never a hardcoded per-tool list,
// so a new tool is classified correctly the moment it gets annotations.
// advisor ⊆ operator ⊆ full. Unset/unrecognized env values fall back to 'full':
// every existing client (which never sets this var) keeps today's behavior.
const TOOL_PROFILES = ['advisor', 'operator', 'full'] as const;
type ToolProfile = (typeof TOOL_PROFILES)[number];

export function activeToolProfile(): ToolProfile {
  const raw = process.env.SANGFOR_TOOL_PROFILE;
  // Unset/empty stays 'full' — every existing client that never sets this var
  // keeps today's behavior. A non-empty but unrecognized value is a typo, not
  // an intentional opt-out of restriction: fail CLOSED to the most-restrictive
  // profile rather than silently granting full access.
  if (raw === undefined || raw === '') return 'full';
  if ((TOOL_PROFILES as readonly string[]).includes(raw)) return raw as ToolProfile;
  process.stderr.write(`[mcp] unrecognized SANGFOR_TOOL_PROFILE '${raw}' — falling back to most-restrictive 'advisor'\n`);
  return 'advisor';
}

// Conservative-by-construction: a tool whose hint is missing or not a strict
// boolean is treated as NOT read-only and AS destructive, so any ambiguity
// only ever pushes a tool toward a higher (more visible) profile — advisor
// never gets a tool it shouldn't have. In practice every tool already carries
// boolean hints (enforced by tests/mcp-tool-annotations.test.ts); this is a
// belt-and-suspenders default, not a live code path today.
function isToolVisibleInProfile(tool: { annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint !== false;
  if (profile === 'advisor') return readOnly;
  return readOnly || !destructive; // operator: advisor ∪ approval-gated writes, excluding destructive
}

export function listToolsForProfile(profile: ToolProfile = activeToolProfile()) {
  const all = listTools();
  return profile === 'full' ? all : all.filter((t) => isToolVisibleInProfile(t, profile));
}

const PROFILE_DESCRIPTIONS: Record<ToolProfile, string> = {
  advisor: 'Read-only advisory tools only (search, evaluate, sizing, RCA, coverage) — never writes or mutates anything.',
  operator: 'Advisor tools plus approval-gated local/plan writes (PM ledger, plans, drafts, playbook authoring) — excludes destructive device/external mutators.',
  full: 'Every tool, including destructive device/external mutators gated by signed approval + SANGFOR_ALLOW_REAL_EXECUTION.',
};

// ─── MCP prompts: curated, workflow-shaped starting points ────────────────────
// Each prompt only names tools that actually exist in `tools` above — verified
// by tests/mcp-prompts.test.ts so a rename can't silently orphan a reference.
type PromptDef = {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  render: (args: Record<string, string>) => string;
};

const PROMPTS: PromptDef[] = [
  {
    name: 'sangfor-health-check',
    description: 'Advisory health-check workflow for a Sangfor/FortiOS/Cisco device: discover the server, run the right advisor tool, evaluate against spec, then collect evidence.',
    arguments: [
      { name: 'product', description: 'Target product/vendor, e.g. SANGFOR HCI_SCP, FORTIOS, CISCO_IOSXE', required: false },
    ],
    render: (args) => [
      `Run a read-only health check${args.product ? ` for ${args.product}` : ''}. Follow this order:`,
      '1. Call sangfor_agent_manifest (or sangfor_capabilities) to confirm which tools are available in the current profile.',
      '2. Call the matching advisor tool: sangfor_advisor_fortios / sangfor_advisor_fortios_advanced for FortiOS, sangfor_advisor_cisco_iosxe / sangfor_advisor_cisco_iosxe_advanced for Cisco IOS-XE, or sangfor_hci_inventory / sangfor_hci_health_report for Sangfor HCI/SCP.',
      '3. If you have an observed config instead of live device access, call sangfor_evaluate_config against the IntendedSpec (use sangfor_list_spec_coverage to see what specs exist).',
      '4. Summarize findings and call sangfor_generate_evidence_report to produce a citable evidence record. Never claim a device was changed — every tool above is read-only.',
    ].join('\n'),
  },
  {
    name: 'sangfor-config-plan',
    description: 'Turn customer requirements into a config plan with risk classification and a validation plan, without touching a device.',
    arguments: [
      { name: 'requirements', description: 'Free-text customer requirements to plan for', required: false },
    ],
    render: (args) => [
      `Build a configuration plan${args.requirements ? ` for: ${args.requirements}` : ''}. Follow this order:`,
      '1. Call sangfor_analyze_customer_requirements (or sangfor_analyze_project) to break requirements into product-specific tasks.',
      '2. Call sangfor_generate_config_plan to produce the precheck/steps/rollback/validation plan.',
      '3. Call sangfor_request_approval to classify the risk of the plan text before proposing any execution.',
      '4. Call sangfor_validate_config_plan to confirm the plan has precheck, steps, rollback and validation before handing it to a human for approval. Do not call any apply_*/execute_* tool from this workflow — those require separate explicit human approval.',
    ].join('\n'),
  },
  {
    name: 'sangfor-troubleshoot',
    description: 'Evidence-first troubleshooting workflow: gather grounded evidence before proposing root causes.',
    arguments: [
      { name: 'symptom', description: 'Observed symptom to investigate', required: false },
    ],
    render: (args) => [
      `Troubleshoot${args.symptom ? `: ${args.symptom}` : ' the reported symptom'}. Follow this order:`,
      '1. Call sangfor_rag_search to collect grounded evidence (manuals, KB, prior lessons) relevant to the symptom. Do not skip this — root causes must be grounded, not guessed.',
      '2. From the retrieved evidence, form one or more hypotheses about the likely cause.',
      '3. Call sangfor_suggest_rca with the symptom (and product, if known) to get ranked root-cause candidates and concrete check steps, and compare them against your hypotheses.',
      '4. If you reach an evaluable observed config, call sangfor_evaluate_config to confirm/refute a hypothesis, then sangfor_generate_evidence_report to record findings.',
    ].join('\n'),
  },
];

const PROMPT_TOOL_NAME_PATTERN = /sangfor_[a-z0-9_]+/g;

// Single source of truth for "which tools does this prompt tell the caller to
// use": scan the rendered body for sangfor_* references. Args only interpolate
// free text (product/requirements/symptom) — they never change which tool
// names appear in the fixed step list, so an empty-args render is exact and
// stable, and both the profile gate below and tests/mcp-prompts.test.ts read
// from this one function instead of duplicating the regex.
export function referencedToolNames(prompt: PromptDef): string[] {
  const text = prompt.render({});
  return Array.from(new Set(text.match(PROMPT_TOOL_NAME_PATTERN) ?? []));
}

// A prompt is only as available as every tool it walks the caller through.
// If ANY referenced tool is hidden in the active profile, the whole prompt is
// hidden too — a partially-runnable workflow is worse than an absent one.
// Fail-closed on an unresolvable reference (should never happen; covered by
// the tool-existence test) rather than assuming it's fine.
function isPromptVisibleInProfile(prompt: PromptDef, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  const toolsByName = new Map(listTools().map((t) => [t.name, t]));
  return referencedToolNames(prompt).every((toolName) => {
    const tool = toolsByName.get(toolName);
    return tool ? isToolVisibleInProfile(tool, profile) : false;
  });
}

export function listPrompts(profile: ToolProfile = activeToolProfile()) {
  return PROMPTS.filter((p) => isPromptVisibleInProfile(p, profile)).map(({ name, description, arguments: args }) => ({
    name,
    description,
    ...(args ? { arguments: args } : {}),
  }));
}

export function getPrompt(name: string, args?: Record<string, unknown>, profile: ToolProfile = activeToolProfile()) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  if (!isPromptVisibleInProfile(prompt, profile)) {
    throw new Error(`Prompt requires tools hidden in profile '${profile}'`);
  }
  const stringArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) if (typeof v === 'string') stringArgs[k] = v;
  return { messages: [{ role: 'user', content: { type: 'text', text: prompt.render(stringArgs) } }] };
}

const SAFETY_POSTURE = {
  default: 'dry-run / read-only',
  liveWriteRequires: ['SANGFOR_ALLOW_REAL_EXECUTION', 'signed action-bound single-use approval'],
  productionAlsoRequires: ['SANGFOR_ALLOW_PRODUCTION_EXECUTION'],
  indeterminateIsNeverPass: true,
  irreversibleActsStayHuman: true,
};

const RESOURCES: Array<{ uri: string; name: string; description: string; mimeType: string; build: () => unknown }> = [
  { uri: 'sangfor://agent-manifest', name: 'Agent manifest', description: 'Recommended first calls and standard tool groups for agent self-onboarding.', mimeType: 'application/json', build: () => tools['sangfor_agent_manifest'].handler({}) },
  { uri: 'sangfor://capabilities', name: 'Server capabilities', description: 'Tool categories, supported vendors/products, and execution posture.', mimeType: 'application/json', build: () => tools['sangfor_capabilities'].handler({}) },
  { uri: 'sangfor://safety/posture', name: 'Safety posture', description: 'Read-only-by-default execution model and the gates a live write must clear.', mimeType: 'application/json', build: () => SAFETY_POSTURE },
];

export function listResources() {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

export function readResource(uri: string) {
  const r = RESOURCES.find((x) => x.uri === uri);
  if (!r) throw new Error(`Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: r.mimeType, text: JSON.stringify(r.build(), null, 2) }] };
}

const DEFAULT_RESULT_MAX_CHARS = 100_000;

function resolveResultMaxChars(): number {
  const raw = process.env.SANGFOR_MCP_RESULT_MAX_CHARS;
  if (raw === undefined) return DEFAULT_RESULT_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESULT_MAX_CHARS;
}

// Cap the tools/call payload: an unbounded chunk/log/atom dump can blow past
// a client's context budget. Caps on serialized char length — UTF-16 code units,
// not bytes, matching the SANGFOR_MCP_RESULT_MAX_CHARS name (independent of the
// disk-side cap in packages/sangfor-runs/run-store.ts's capResultJson — this one
// governs what actually crosses the MCP wire) and replaces BOTH content[0].text
// and structuredContent with the same truncation marker so a client can't read
// full detail from one field after the other was capped.
function capMcpResult(toolName: string, result: unknown): { result: unknown; text: string } {
  const text = JSON.stringify(result);
  const maxChars = resolveResultMaxChars();
  if (text.length <= maxChars) return { result, text };
  const capped = { truncated: true, tool: toolName, originalChars: text.length, hint: 'narrow the query or use pagination/cursor inputs' };
  return { result: capped, text: JSON.stringify(capped) };
}

export async function handle(req: JsonRpcRequest) {
  try {
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sangfor-engineer-mcp', version: '0.1.0' }, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } } } };
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id, result: { tools: listToolsForProfile() } };
    }
    if (req.method === 'resources/list') {
      return { jsonrpc: '2.0', id: req.id, result: { resources: listResources() } };
    }
    if (req.method === 'resources/read') {
      const uri = req.params?.uri;
      return { jsonrpc: '2.0', id: req.id, result: readResource(uri) };
    }
    if (req.method === 'prompts/list') {
      return { jsonrpc: '2.0', id: req.id, result: { prompts: listPrompts() } };
    }
    if (req.method === 'prompts/get') {
      const name = req.params?.name;
      const args = req.params?.arguments;
      return { jsonrpc: '2.0', id: req.id, result: getPrompt(name, args) };
    }
    if (req.method === 'tools/call') {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const tool = tools[name];
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const profile = activeToolProfile();
      if (profile !== 'full' && !isToolVisibleInProfile({ annotations: annotationsFor(name, tool.description) }, profile)) {
        throw new Error(`Tool not available in profile '${profile}'; set SANGFOR_TOOL_PROFILE=full`);
      }
      const raw = await tool.handler(args);
      const { result, text } = capMcpResult(name, raw);
      return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }], structuredContent: result, isError: false } };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  } catch (error) {
    return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true } };
  }
}

function startStdioServer() {
  if (!browserExecutionPort || !observerTransport) {
    const localRuntime = createDefaultJmBrowserRuntime();
    const remoteExecutionPort = createRemoteBrowserExecutionPortFromEnv();
    configureJmBrowserRuntime({
      ...localRuntime,
      executionPort: remoteExecutionPort ?? localRuntime.executionPort,
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let shutdown: Promise<void> | undefined;
  const disposeBrowserRuntime = () => {
    shutdown ??= browserRuntimeDispose?.() ?? Promise.resolve();
    return shutdown;
  };
  const reportShutdownFailure = (error: unknown) => {
    process.exitCode = 1;
    console.error('JM browser runtime shutdown failed:', error);
  };
  rl.once('close', () => {
    void disposeBrowserRuntime().catch(reportShutdownFailure);
  });
  process.once('SIGINT', () => {
    void (async () => {
      process.exitCode = 130;
      rl.close();
      await disposeBrowserRuntime();
    })().catch(reportShutdownFailure);
  });
  process.once('SIGTERM', () => {
    void (async () => {
      process.exitCode = 143;
      rl.close();
      await disposeBrowserRuntime();
    })().catch(reportShutdownFailure);
  });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // Malformed JSON must not crash the stdio server — emit a JSON-RPC parse error.
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    try {
      const res = await handle(req);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: String(err instanceof Error ? err.message : err) } })}\n`);
    }
  });

  process.on('unhandledRejection', (e) => process.stderr.write(`unhandledRejection: ${String(e)}\n`));
  process.on('uncaughtException', (e) => process.stderr.write(`uncaughtException: ${String(e)}\n`));

  process.stderr.write('sangfor-engineer-mcp stdio server started\n');
}

// Guard: importing this module (e.g. from tests) must not start the stdio loop.
if (process.env.MCP_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  // Honor the repo-root .env for a SERVING process only (never for test imports):
  // pipeline scripts already load it, and without it here a stdio session can
  // request a different embedding model than the one the index was built with
  // (query/index vector-space mismatch). Existing process env always wins.
  loadEnvFile('.env', resolveRepoData('.'));
  startStdioServer();
}
