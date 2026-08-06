/**
 * @sangfor/office — thin execFile wrapper around the officecli binary
 * (AI-friendly CLI for .docx/.xlsx/.pptx: validate/create/batch/dump/...).
 *
 * Design contract (per card O1):
 *  - Never shells out — execFile with an argv array only, no shell:true,
 *    no string concatenation into a command line.
 *  - validateOfficeDocument NEVER throws: a missing/broken officecli
 *    degrades to {valid:null, note:'officecli unavailable'} so a customer
 *    environment without officecli never blocks document generation, only
 *    the (best-effort) validation step.
 *  - createOfficeDocument / runOfficeBatch confine their write target to an
 *    allowed root (see ./confine.ts) and throw OFFICE_PATH_OUTSIDE_ROOT if
 *    the caller tries to write outside it. officecli itself being
 *    unavailable is reported via the returned {ok:false, error} shape
 *    rather than a throw, matching runOfficeBatch's declared return type.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { confineOfficePath } from './confine.js';

export { confineOfficePath, OFFICE_ROOT_ENV_VAR } from './confine.js';

const OFFICECLI_BIN = process.env.SANGFOR_OFFICECLI_BIN?.trim() || 'officecli';
const DEFAULT_TIMEOUT_MS = 60_000;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Availability probe ─────────────────────────────────────────────────────

export interface OfficeCliAvailability {
  available: boolean;
  version?: string;
  detail?: string;
}

let availabilityCache: OfficeCliAvailability | undefined;

/**
 * Probes `officecli --version`. Result is cached for the lifetime of the
 * process (officecli install state doesn't change mid-session in practice);
 * pass refresh:true to force a fresh probe — mainly for tests that swap
 * PATH/SANGFOR_OFFICECLI_BIN to simulate an unavailable officecli.
 */
export function isOfficeCliAvailable(opts: { refresh?: boolean } = {}): OfficeCliAvailability {
  if (!opts.refresh && availabilityCache) return availabilityCache;
  const result = spawnSync(OFFICECLI_BIN, ['--version'], { timeout: 5_000, encoding: 'utf8' });
  if (result.error) {
    availabilityCache = { available: false, detail: result.error.message };
  } else if (result.status !== 0) {
    availabilityCache = { available: false, detail: `exit ${result.status}: ${(result.stderr || '').trim()}` };
  } else {
    availabilityCache = { available: true, version: (result.stdout || '').trim() };
  }
  return availabilityCache;
}

// ─── Low-level execFile runner ──────────────────────────────────────────────

interface RawRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `officecli <args>` via execFile (no shell). Resolves with the exit
 * code + captured stdout/stderr for ANY numeric exit code — officecli
 * legitimately exits 1 for "validation found errors" / "batch item failed"
 * while still emitting well-formed --json on stdout, so a nonzero exit is
 * not by itself a runner-level failure. Only spawn-level failures (binary
 * missing, EACCES, timeout/kill) reject.
 */
function runOfficeCliRaw(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RawRunResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      OFFICECLI_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const anyErr = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null };
          if (typeof anyErr.code === 'string') {
            reject(new Error(`OFFICECLI_SPAWN_FAILED: ${anyErr.message}`));
            return;
          }
          if (anyErr.killed || anyErr.signal) {
            reject(new Error(`OFFICECLI_TIMEOUT: officecli ${args[0] ?? ''} did not complete within ${timeoutMs}ms`));
            return;
          }
          resolvePromise({ code: typeof anyErr.code === 'number' ? anyErr.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

function extractOfficeCliError(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.error === 'string') return p.error;
    if (p.error && typeof p.error === 'object') {
      const inner = p.error as Record<string, unknown>;
      if (typeof inner.error === 'string') return inner.error;
    }
    if (typeof p.message === 'string' && p.message) return p.message;
  }
  return undefined;
}

// ─── validate ────────────────────────────────────────────────────────────────

export interface ValidateOfficeDocumentResult {
  valid: boolean | null;
  errorCount: number;
  errors: string[];
  note?: string;
}

/**
 * Groups officecli's flat `warnings` array (one "Found N validation
 * error(s):" summary line, then N groups of [schema message, Path: ..,
 * Part: ..]) into one combined string per validation error, so
 * errors.length matches errorCount.
 */
function parseValidateOutput(stdout: string): ValidateOfficeDocumentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { valid: null, errorCount: 0, errors: [], note: 'OFFICECLI_VALIDATE_NON_JSON_OUTPUT' };
  }
  const p = parsed as Record<string, unknown>;
  if (p?.success === true) {
    return { valid: true, errorCount: 0, errors: [] };
  }

  const rawWarnings: unknown[] = Array.isArray(p?.warnings) ? (p.warnings as unknown[]) : [];
  const warningMessages = rawWarnings
    .map((w) => (w && typeof w === 'object' && typeof (w as Record<string, unknown>).message === 'string' ? (w as Record<string, unknown>).message as string : ''))
    .filter(Boolean);

  let declaredCount: number | undefined;
  const groups: string[] = [];
  let current: string[] = [];
  for (const msg of warningMessages) {
    const foundMatch = /^Found (\d+) validation error/.exec(msg);
    if (foundMatch) {
      declaredCount = Number(foundMatch[1]);
      continue;
    }
    const isContinuation = /^(Path|Part):/.test(msg);
    if (isContinuation && current.length > 0) {
      current.push(msg);
    } else {
      if (current.length > 0) groups.push(current.join(' | '));
      current = [msg];
    }
  }
  if (current.length > 0) groups.push(current.join(' | '));

  if (groups.length === 0) {
    const fallback = extractOfficeCliError(parsed) ?? 'officecli reported failure with no parsable warnings';
    return { valid: false, errorCount: declaredCount ?? 1, errors: [fallback] };
  }

  return { valid: false, errorCount: declaredCount ?? groups.length, errors: groups };
}

/**
 * Read-only OpenXML schema validation via `officecli validate --json`.
 * NEVER throws: when officecli is unavailable, or the probe/spawn itself
 * fails, this degrades to {valid:null, note:'officecli unavailable'} so
 * callers (document builders, the sangfor_validate_office_document tool)
 * can treat validation as best-effort without ever failing the caller's own
 * operation. Not path-confined — this only reads the file, it never writes.
 */
export async function validateOfficeDocument(path: string): Promise<ValidateOfficeDocumentResult> {
  const availability = isOfficeCliAvailable();
  if (!availability.available) {
    return { valid: null, errorCount: 0, errors: [], note: 'officecli unavailable' };
  }
  try {
    const { stdout } = await runOfficeCliRaw(['validate', path, '--json']);
    return parseValidateOutput(stdout);
  } catch (error) {
    return { valid: null, errorCount: 0, errors: [], note: `officecli unavailable: ${errMsg(error)}` };
  }
}

// ─── create ──────────────────────────────────────────────────────────────────

export type OfficeDocumentFormat = 'docx' | 'xlsx' | 'pptx';

export interface CreateOfficeDocumentResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * Creates a blank Office document via `officecli create --json`. Confines
 * the write target to the allowed root (throws OFFICE_PATH_OUTSIDE_ROOT if
 * outside it — a real, loud failure since that's a security invariant).
 * An unavailable/failing officecli is reported via {ok:false, error}
 * instead of throwing, so a caller building a bigger pipeline can decide
 * how to react.
 *
 * P2 fix: defaults to REFUSING to touch a target that already exists on
 * disk — a customer-facing .docx/.pptx sitting at that path must never be
 * silently replaced by a blank document just because someone re-ran a
 * generator. Pass opts.overwrite:true to explicitly allow replacing it
 * (only --force officecli's own create when that's the case).
 */
export async function createOfficeDocument(
  path: string,
  format?: OfficeDocumentFormat,
  opts: { root?: string; overwrite?: boolean; timeoutMs?: number } = {},
): Promise<CreateOfficeDocumentResult> {
  const confined = confineOfficePath(path, opts.root);

  if (!opts.overwrite && existsSync(confined)) {
    return { ok: false, path: confined, error: `OFFICE_FILE_EXISTS: ${confined} (pass overwrite:true to replace)` };
  }

  const availability = isOfficeCliAvailable();
  if (!availability.available) {
    return { ok: false, path: confined, error: `OFFICECLI_UNAVAILABLE: ${availability.detail ?? 'officecli not found on PATH'}` };
  }

  const args = ['create', confined, '--json'];
  if (format) args.push('--type', format);
  if (opts.overwrite) args.push('--force');

  try {
    const { code, stdout, stderr } = await runOfficeCliRaw(args, opts.timeoutMs);
    if (code !== 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
      const error = extractOfficeCliError(parsed) ?? ((stderr || stdout).trim() || `officecli create exited ${code}`);
      return { ok: false, path: confined, error };
    }
    return { ok: true, path: confined };
  } catch (error) {
    return { ok: false, path: confined, error: errMsg(error) };
  }
}

// ─── batch ───────────────────────────────────────────────────────────────────

export interface RunOfficeBatchResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

/**
 * Executes a batch of officecli add/set/remove/move/swap/... commands
 * against `path` via `officecli batch --input <tmpfile> --json` (commands
 * go through a temp file rather than an argv string to avoid OS argv-length
 * limits on large batches). Confines the write target to the allowed root.
 * Never throws for officecli-level failure (unavailable, nonzero exit,
 * spawn error) — always resolves to {ok, output, error?}, matching the
 * documented return shape.
 */
export async function runOfficeBatch(
  path: string,
  commands: object[],
  opts: { root?: string; timeoutMs?: number } = {},
): Promise<RunOfficeBatchResult> {
  // Path confinement is a security invariant (O1: "throw") — deliberately
  // NOT caught here, unlike the officecli-level failures below.
  const confined = confineOfficePath(path, opts.root);

  const availability = isOfficeCliAvailable();
  if (!availability.available) {
    return { ok: false, output: null, error: `OFFICECLI_UNAVAILABLE: ${availability.detail ?? 'officecli not found on PATH'}` };
  }

  const tmpFile = join(tmpdir(), `sangfor-office-batch-${randomBytes(8).toString('hex')}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(commands));
    const { code, stdout, stderr } = await runOfficeCliRaw(['batch', confined, '--input', tmpFile, '--json'], opts.timeoutMs);
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
    if (code !== 0) {
      const error = extractOfficeCliError(parsed) ?? ((stderr || stdout).trim() || `officecli batch exited ${code}`);
      return { ok: false, output: parsed ?? stdout, error };
    }
    return { ok: true, output: parsed ?? stdout };
  } catch (error) {
    return { ok: false, output: null, error: errMsg(error) };
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch { /* best-effort temp-file cleanup */ }
  }
}

// ─── close ───────────────────────────────────────────────────────────────────

export interface CloseOfficeDocumentResult {
  ok: boolean;
  error?: string;
}

/**
 * Flushes a resident officecli session's in-memory changes to disk and
 * releases the file, via `officecli close --json`. createOfficeDocument
 * leaves the file open in a background resident for fast follow-up
 * commands; a resident's writes are only guaranteed on disk after an
 * explicit close/save (or an adaptive idle auto-flush) — so any caller that
 * hands the resulting path to something outside officecli (a customer, a
 * non-officecli reader, this repo's own statSync-based size checks) must
 * close first. Confines the target the same way createOfficeDocument/
 * runOfficeBatch do (P1 fix — this used to pass the caller's path straight
 * to officecli close, which flushes/writes to disk, without confinement).
 * Best-effort beyond that: never throws for an officecli-level failure,
 * returns {ok:false, error} instead so a caller can decide whether an
 * unflushed file is fatal.
 */
export async function closeOfficeDocument(path: string, opts: { root?: string; timeoutMs?: number } = {}): Promise<CloseOfficeDocumentResult> {
  // Path confinement is a security invariant (O1: "throw") — deliberately
  // NOT caught here, matching createOfficeDocument/runOfficeBatch.
  const confined = confineOfficePath(path, opts.root);

  const availability = isOfficeCliAvailable();
  if (!availability.available) {
    return { ok: false, error: `OFFICECLI_UNAVAILABLE: ${availability.detail ?? 'officecli not found on PATH'}` };
  }
  try {
    const { code, stdout, stderr } = await runOfficeCliRaw(['close', confined, '--json'], opts.timeoutMs);
    if (code !== 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
      return { ok: false, error: extractOfficeCliError(parsed) ?? ((stderr || stdout).trim() || `officecli close exited ${code}`) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errMsg(error) };
  }
}
