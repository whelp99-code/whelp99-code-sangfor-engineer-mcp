/**
 * Console evidence capture — read-only browser-console screenshot capture for
 * customer-engagement audit evidence (EPP/IAG/CC/SCP ExtJS consoles).
 *
 * Card B1: attaches to an ALREADY-RUNNING Chrome (CDP) session, walks a list
 * of menu targets, screenshots each one under a deterministic filename, and
 * hash-chains the whole session into the shared AuditLedger so the resulting
 * PNGs are provably "this screen, at this time, unmodified since".
 *
 * READ-ONLY INVARIANT: this module must never submit a form, click Save/
 * Delete/Apply, or otherwise mutate device state. The only page interactions
 * it performs are navigation — page.goto(url) and @sangfor/chrome's
 * navigateMenu (menu/submenu text clicks) — followed by a screenshot. Do not
 * add form-fill, dialog-open, or button-submit calls to this file; that
 * belongs to the (approval-gated, destructive) operator tools, not here.
 * Because menuPath/menuLabel are caller-controlled, this module additionally
 * REFUSES to click any label matching a destructive-word denylist (see
 * findDestructiveLabel) — a caller cannot use us to click Delete/Save/Apply/
 * Confirm/etc. by disguising it as "navigation"; such capture items are not
 * executed at all and are recorded as ok:false.
 */
import { createHash, createHmac } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AuditLedger } from '@sangfor/hci-client';
import { nowId, resolveEngagementScopedData, type ProductCode } from '@sangfor/shared';
import { navigateMenu, takeScreenshot, type MenuPathStep } from '@sangfor/chrome';

// Distinct from @sangfor/chrome's DEFAULT_CDP_PORT (9333, used when this repo
// launches its own Chrome) — this tool attaches to a console the engineer
// already has open, and 9222 is the conventional Chrome remote-debugging
// default engineers reach for first.
export const DEFAULT_CONSOLE_CDP_PORT = 9222;

export interface ConsoleCaptureRequest {
  reqId: string;
  menuLabel: string;
  menuPath?: MenuPathStep[];
  url?: string;
}

export interface CaptureConsoleEvidenceInput {
  cdpPort?: number;
  product: ProductCode;
  captures: ConsoleCaptureRequest[];
  outputDir: string;
  dateStamp?: string;
  engagementId?: string;
}

export interface ConsoleCaptureItemResult {
  reqId: string;
  menuLabel: string;
  filePath: string;
  sha256: string | null;
  capturedAt: string;
  ok: boolean;
  error?: string;
}

export interface CaptureConsoleEvidenceResult {
  runId: string;
  outputDir: string;
  captures: ConsoleCaptureItemResult[];
  ledgerPath: string;
  chainOk: boolean;
}

/** Minimal page surface this module drives — satisfied by a real Playwright
 * Page (via connectOverCDP) or a fake in tests. Intentionally loose (`any`
 * passthrough) because navigateMenu/takeScreenshot from @sangfor/chrome
 * already accept `page: any`. */
export type ConsolePage = any;

export type PageProvider = (cdpPort: number) => Promise<{ page: ConsolePage }>;

export interface CaptureConsoleEvidenceDeps {
  getPage?: PageProvider;
  ledger?: AuditLedger;
}

function cdpAttachError(cdpPort: number): Error {
  return new Error(
    `CDP_ATTACH_FAILED: no Chrome listening on ${cdpPort} (start Chrome with --remote-debugging-port=${cdpPort})`,
  );
}

/**
 * Default page provider: attach to an already-running Chrome over CDP.
 * Never launches a new browser — if nothing is listening on cdpPort this
 * throws CDP_ATTACH_FAILED with the exact remediation the engineer needs.
 * (This is a deliberate hard failure, not a partial-failure case: without a
 * page nothing in the batch can be attempted, so it isn't per-item.)
 */
async function defaultGetPage(cdpPort: number): Promise<{ page: ConsolePage }> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw cdpAttachError(cdpPort);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  } catch {
    throw cdpAttachError(cdpPort);
  }

  const context = browser.contexts()[0] ?? (await browser.newContext({ ignoreHTTPSErrors: true }));
  const page = context.pages()[0] ?? (await context.newPage());
  return { page };
}

// Exported so callers (e.g. the MCP tool) can derive a matching default
// outputDir (data/evidence/captures/<YYYYMMDD>/) using the exact same stamp
// this module would otherwise compute internally.
export function formatDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Filename segments are limited to [A-Za-z0-9._-]; anything else (spaces,
// slashes, unicode, etc.) becomes '_'. Runs of '.' are also collapsed so a
// segment can never smuggle a '..' path-traversal component through, and
// leading/trailing '_' from the substitution is trimmed for readability.
function normalizeSegment(raw: string): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/[^A-Za-z0-9._-]/g, '_');
  s = s.replace(/\.{2,}/g, '_');
  s = s.replace(/_{2,}/g, '_');
  s = s.replace(/^[_.]+|[_.]+$/g, '');
  return s || 'unnamed';
}

function buildFilePath(outputDir: string, reqId: string, product: string, menuLabel: string, dateStamp: string): string {
  const fileName = `REQ${normalizeSegment(reqId)}_${normalizeSegment(product)}_${normalizeSegment(menuLabel)}_Before_${normalizeSegment(dateStamp)}.png`;
  return join(outputDir, fileName);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ─── S1: outputDir confinement (security) ──────────────────────────────────
// A remote MCP client fully controls `outputDir`. Without confinement it
// could point captures at an arbitrary filesystem path (e.g. /etc/cron.d).
// The allowed root is fixed to the same (subdir, envVar) pair the MCP tool
// uses for its own default outputDir, so a legitimate default always lands
// inside the root this function accepts. Same realpath-confinement
// precedent as packages/sangfor-spec/src/index.ts:137-190 — every path
// segment between the root and the target is walked and created one level
// at a time, and a pre-existing symlink anywhere in that chain (which could
// redirect us outside the root even if it lexically looks confined) is
// rejected outright, never followed.
export const CAPTURE_EVIDENCE_ROOT_ENV_VAR = 'SANGFOR_EVIDENCE_ROOT';

function isConfinedDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function resolveConfinedOutputDir(requestedOutputDir: string): string {
  const root = resolveEngagementScopedData('data/evidence', CAPTURE_EVIDENCE_ROOT_ENV_VAR);
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);

  const outsideError = () => new Error(`CAPTURE_DIR_OUTSIDE_ROOT: ${requestedOutputDir} is outside ${rootReal}`);

  // Lexical check first (cheap, and rejects absolute-elsewhere / '..' escapes
  // before anything touches the filesystem).
  const requestedAbs = resolve(rootReal, requestedOutputDir);
  if (requestedAbs !== rootReal && !isConfinedDescendant(rootReal, requestedAbs)) {
    throw outsideError();
  }

  // Walk + create one segment at a time, from the (already-real) root down.
  // Any segment that already exists is required to be a real directory —
  // never a symlink — so a pre-planted symlink can't redirect later segments
  // (or the final target) outside the root.
  let current = rootReal;
  const relPath = relative(rootReal, requestedAbs);
  if (relPath !== '') {
    for (const segment of relPath.split(sep).filter(Boolean)) {
      const next = join(current, segment);
      let lex: Stats | null;
      try {
        lex = lstatSync(next);
      } catch {
        lex = null;
      }
      if (lex) {
        if (lex.isSymbolicLink() || !lex.isDirectory()) throw outsideError();
      } else {
        mkdirSync(next);
      }
      current = next;
    }
  }

  const outReal = realpathSync(current);
  if (outReal !== rootReal && !isConfinedDescendant(rootReal, outReal)) throw outsideError();
  return outReal;
}

// ─── S2: destructive-label denylist (security) ─────────────────────────────
// menuPath/menuLabel are caller-controlled text that this module clicks
// through @sangfor/chrome's navigateMenu. A caller could try to disguise a
// destructive action as "navigation" (e.g. a menuPath step labeled
// "Delete"). Any label matching this denylist (case-insensitive, substring)
// causes the WHOLE capture item to be refused — nothing is clicked or
// screenshotted for it — rather than attempted and merely hoped-safe.
const DESTRUCTIVE_LABEL_RE = /(delete|remove|save|apply|confirm|submit|restart|reboot|format|삭제|저장|적용|확인|재시작)/i;

function findDestructiveLabel(item: ConsoleCaptureRequest): string | null {
  const candidates: string[] = [item.menuLabel];
  for (const step of item.menuPath ?? []) {
    candidates.push(step.menu);
    if (step.submenu) candidates.push(step.submenu);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && DESTRUCTIVE_LABEL_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Capture read-only console-screen evidence from an already-open Chrome
 * session and hash-chain the result into the shared AuditLedger.
 *
 * READ-ONLY: only navigates (goto/menu clicks) and screenshots, and refuses
 * destructive-looking menu labels outright. See the module-level comment
 * for the full contract this function must uphold.
 *
 * Partial failure is expected and handled: one capture item failing (bad
 * menu label, navigation timeout, refused destructive label, etc.) is
 * recorded with ok:false and does NOT stop the remaining items from being
 * attempted. The one exception is CDP attach failure (see defaultGetPage) —
 * that is a hard failure by design, since without a page nothing can be
 * attempted at all.
 */
export async function captureConsoleEvidence(
  input: CaptureConsoleEvidenceInput,
  deps: CaptureConsoleEvidenceDeps = {},
): Promise<CaptureConsoleEvidenceResult> {
  const cdpPort = input.cdpPort ?? DEFAULT_CONSOLE_CDP_PORT;
  const dateStamp = input.dateStamp ?? formatDateStamp(new Date());
  const getPage = deps.getPage ?? defaultGetPage;
  const ledger = deps.ledger ?? new AuditLedger();
  const runId = nowId('console_capture');

  // S1: confine outputDir BEFORE attaching to CDP — a bad path should fail
  // fast without ever touching the browser.
  const outputDir = resolveConfinedOutputDir(input.outputDir);

  const { page } = await getPage(cdpPort);

  const results: ConsoleCaptureItemResult[] = [];

  for (const item of input.captures) {
    const filePath = buildFilePath(outputDir, item.reqId, input.product, item.menuLabel, dateStamp);
    const capturedAt = new Date().toISOString();

    const destructiveLabel = findDestructiveLabel(item);
    if (destructiveLabel) {
      const record: ConsoleCaptureItemResult = {
        reqId: item.reqId, menuLabel: item.menuLabel, filePath, sha256: null, capturedAt, ok: false,
        error: `REFUSED_DESTRUCTIVE_MENU_LABEL: ${destructiveLabel}`,
      };
      results.push(record);
      ledger.append(runId, 'response', {
        reqId: record.reqId, menuLabel: record.menuLabel, filePath: record.filePath,
        sha256: record.sha256, capturedAt: record.capturedAt, ok: record.ok, error: record.error,
        product: input.product, engagementId: input.engagementId,
      });
      continue;
    }

    try {
      if (item.url) {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      if (item.menuPath?.length) {
        await navigateMenu(page, item.menuPath);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      await takeScreenshot(page, filePath);
      const sha256 = sha256File(filePath);

      const record: ConsoleCaptureItemResult = { reqId: item.reqId, menuLabel: item.menuLabel, filePath, sha256, capturedAt, ok: true };
      results.push(record);
      ledger.append(runId, 'response', {
        reqId: record.reqId, menuLabel: record.menuLabel, filePath: record.filePath,
        sha256: record.sha256, capturedAt: record.capturedAt, ok: record.ok,
        product: input.product, engagementId: input.engagementId,
      });
    } catch (error) {
      const record: ConsoleCaptureItemResult = {
        reqId: item.reqId, menuLabel: item.menuLabel, filePath, sha256: null, capturedAt, ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(record);
      ledger.append(runId, 'response', {
        reqId: record.reqId, menuLabel: record.menuLabel, filePath: record.filePath,
        sha256: record.sha256, capturedAt: record.capturedAt, ok: record.ok, error: record.error,
        product: input.product, engagementId: input.engagementId,
      });
    }
  }

  const { ok: chainOk } = ledger.verify(runId);

  return {
    runId,
    outputDir,
    captures: results,
    ledgerPath: ledger.pathFor(runId),
    chainOk,
  };
}

/**
 * Read-only: verify a console-capture run's ledger hash chain AND cross-check
 * each recorded capture's sha256 against the file's current on-disk hash.
 * Detects both ledger tampering (chainOk) and post-capture file tampering
 * (per-file match:false).
 */
export interface CaptureLedgerFileCheck {
  filePath: string;
  recordedHash: string | null;
  currentHash: string | null;
  match: boolean;
  note?: string;
}

export interface VerifyCaptureLedgerResult {
  runId: string;
  chainOk: boolean;
  files: CaptureLedgerFileCheck[];
  allMatch: boolean;
}

// AuditLedger doesn't expose a public line reader (append/verify only) — this
// mirrors its own private readLines() against the same on-disk JSONL file,
// read-only, without touching audit-ledger.ts itself.
interface RawLedgerLine { seq: number; kind: string; payload: unknown; prevHash: string; hash: string; keyed: boolean }

function readLedgerLines(ledger: AuditLedger, runId: string): RawLedgerLine[] {
  try {
    const raw = readFileSync(ledger.pathFor(runId), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// S3: mirrors AuditLedger's own verify() digest algorithm (audit-ledger.ts
// itself is NOT modified) so the chain verdict can be derived from the SAME
// single in-memory snapshot (readLedgerLines' one readFileSync) used for the
// per-file hash comparison below. Calling ledger.verify(runId) — which does
// its own independent readFileSync — as a second, separate read would leave
// a window where the on-disk file could be swapped between the two reads,
// letting a tampered file slip past whichever check ran against the stale
// copy. secret defaults exactly like AuditLedger's own constructor does
// (opts.secret ?? SANGFOR_CHANGE_LEDGER_SECRET), which matches every default
// AuditLedger() this module and its callers construct; a caller using a
// custom-secret AuditLedger must pass the same secret via deps.secret for
// this to verify correctly.
function ledgerDigest(secret: string | undefined, prevHash: string, seq: number, kind: string, payload: unknown): string {
  const material = `${prevHash}\n${seq}\n${kind}\n${JSON.stringify(payload)}`;
  return secret ? createHmac('sha256', secret).update(material).digest('hex') : createHash('sha256').update(material).digest('hex');
}

function verifyChainFromLines(lines: RawLedgerLine[], secret: string | undefined): { ok: boolean; keyed: boolean } {
  const keyed = lines.every((l) => l.keyed) && Boolean(secret);
  let prevHash = 'GENESIS';
  for (const [i, line] of lines.entries()) {
    const expected = ledgerDigest(secret, prevHash, line.seq, line.kind, line.payload);
    if (line.seq !== i || line.prevHash !== prevHash || line.hash !== expected) {
      return { ok: false, keyed };
    }
    prevHash = line.hash;
  }
  return { ok: true, keyed };
}

// S4: the per-capture payload shape (filePath: string, sha256: string|null)
// is our own convention (captureConsoleEvidence always writes it), but the
// ledger file is just JSONL on disk — a line in an unexpected shape (hand-
// edited, written by a different producer, truncated, etc.) must not be
// silently skipped or coerced, which would hide a verification gap. Such
// lines are reported explicitly as match:false / currentHash:null /
// note:'LEDGER_SHAPE_UNEXPECTED' instead.
function isCapturePayloadShape(payload: unknown): payload is { filePath: string; sha256: string | null } {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.filePath === 'string' && (typeof p.sha256 === 'string' || p.sha256 === null);
}

export function verifyCaptureLedger(runId: string, deps: { ledger?: AuditLedger; secret?: string } = {}): VerifyCaptureLedgerResult {
  const ledger = deps.ledger ?? new AuditLedger();
  const secret = deps.secret ?? process.env.SANGFOR_CHANGE_LEDGER_SECRET;

  // Single read — everything below is derived from this one snapshot (S3).
  const lines = readLedgerLines(ledger, runId);
  const { ok: chainOk } = verifyChainFromLines(lines, secret);

  const files: CaptureLedgerFileCheck[] = lines.map((line) => {
    if (!isCapturePayloadShape(line.payload)) {
      const maybeFilePath = typeof (line.payload as Record<string, unknown> | null)?.filePath === 'string'
        ? (line.payload as Record<string, unknown>).filePath as string
        : '';
      return { filePath: maybeFilePath, recordedHash: null, currentHash: null, match: false, note: 'LEDGER_SHAPE_UNEXPECTED' };
    }
    const { filePath, sha256: recordedHash } = line.payload;
    let currentHash: string | null = null;
    try {
      currentHash = sha256File(filePath);
    } catch {
      currentHash = null;
    }
    const match = recordedHash !== null && currentHash !== null && recordedHash === currentHash;
    return { filePath, recordedHash, currentHash, match };
  });

  return { runId, chainOk, files, allMatch: chainOk && files.every((f) => f.match) };
}
