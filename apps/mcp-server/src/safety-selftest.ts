import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizeApprovalPayload, FileSingleUseNonceStore, verifyDomainApprovalSignature } from '../../../packages/sangfor-approval/src/index.js';
import { resolveProductionLocalWriteAuthority, resolveRepoData } from '../../../packages/shared/src/index.js';
import { authorizeSafetySelftestToolCall } from './tool-authorization-consumer.js';

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
    const decision = await authorizeSafetySelftestToolCall({ name: 'sangfor_selftest_destructive_probe', toolListResult, enforceWhitelist: true });
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
