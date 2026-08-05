import { beforeAll, describe, expect, it } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;
let listTools: () => Array<{ name: string; annotations?: any }>;
let runSafetySelftest: (opts?: { operatorGateTimeoutMs?: number }) => {
  checks: Array<{ name: string; expectation: string; outcome: string; pass: boolean; detail: string }>;
  skippedCount: number;
  allPass: boolean;
};

// The operator-gate check now spawns a real child process (tsx + node) per
// call — computed ONCE here and shared across assertions below instead of
// re-invoking the (relatively slow) subprocess per `it`.
let result: ReturnType<typeof runSafetySelftest>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mod.getToolHandler as typeof getToolHandler;
  listTools = (mod as any).listTools;
  runSafetySelftest = (mod as any).runSafetySelftest;
  result = getToolHandler('sangfor_safety_selftest')!({}) as typeof result;
}, 30_000);

describe('sangfor_safety_selftest (W4 C3)', () => {
  it('is read-only (readOnlyHint:true, destructiveHint:false) — never touches a device or the network', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_safety_selftest');
    expect(tool).toBeTruthy();
    expect(tool!.annotations.readOnlyHint).toBe(true);
    expect(tool!.annotations.destructiveHint).toBe(false);
  });

  it('allPass is true, skippedCount is reported, and every check is refused or honestly skipped (never allowed)', () => {
    expect(result.allPass).toBe(true);
    expect(typeof result.skippedCount).toBe('number');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(4);
    for (const check of result.checks) {
      expect(check.expectation).toBe('refused');
      expect(['refused', 'skipped']).toContain(check.outcome);
      expect(check.pass).toBe(true);
      expect(typeof check.detail).toBe('string');
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  it('allPass only counts EXECUTED checks — a skipped check is excluded from the aggregate, not counted as a pass', () => {
    const executed = result.checks.filter((c) => c.outcome !== 'skipped');
    const skipped = result.checks.filter((c) => c.outcome === 'skipped');
    expect(result.skippedCount).toBe(skipped.length);
    expect(result.allPass).toBe(executed.every((c) => c.pass));
    // A skipped check's detail must say it does not constitute proof.
    for (const c of skipped) expect(c.detail).toMatch(/not proof/i);
  });

  it('in a normal dev environment, the operator real-execution gate check actually runs and is refused (pinned — not skipped)', () => {
    const gateCheck = result.checks.find((c) => c.name === 'operator.assertRealExecutionAllowed');
    expect(gateCheck).toBeTruthy();
    expect(gateCheck!.outcome).toBe('refused');
    expect(gateCheck!.pass).toBe(true);
    expect(gateCheck!.detail).toMatch(/clean env/i);
  }, 15_000);

  it('the operator gate check falls back to skipped (not allowed, not a hard failure) when the subprocess cannot complete in time', () => {
    const timedOut = runSafetySelftest({ operatorGateTimeoutMs: 1 });
    const gateCheck = timedOut.checks.find((c) => c.name === 'operator.assertRealExecutionAllowed')!;
    expect(gateCheck.outcome).toBe('skipped');
    expect(gateCheck.pass).toBe(true);
    expect(gateCheck.detail).toMatch(/not proof/i);
    // The timed-out check must not count toward allPass's executed-only aggregate.
    expect(timedOut.skippedCount).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('the http-bridge tool-guard check actually refuses a destructive tool call with no approval', () => {
    const guardCheck = result.checks.find((c) => c.name === 'http-bridge.authorizeToolCall');
    expect(guardCheck!.outcome).toBe('refused');
  });

  it('the forged-signature check actually refuses a bad HMAC signature', () => {
    const sigCheck = result.checks.find((c) => c.name === 'approval.verifyDomainApprovalSignature');
    expect(sigCheck!.outcome).toBe('refused');
  });

  it('the nonce-replay check actually refuses reuse of a single-use nonce', () => {
    const nonceCheck = result.checks.find((c) => c.name === 'approval.FileSingleUseNonceStore replay');
    expect(nonceCheck!.outcome).toBe('refused');
  });

  it('never touches the real durable nonce store (data/runtime)', async () => {
    const { existsSync, statSync } = await import('node:fs');
    const before = existsSync('data/runtime/approval-nonces.json') ? statSync('data/runtime/approval-nonces.json').mtimeMs : null;
    getToolHandler('sangfor_safety_selftest')!({});
    const after = existsSync('data/runtime/approval-nonces.json') ? statSync('data/runtime/approval-nonces.json').mtimeMs : null;
    expect(after).toBe(before);
  }, 15_000);

  it('is deterministic and repeatable (running it twice does not break replay detection via cross-run state)', () => {
    const first: any = getToolHandler('sangfor_safety_selftest')!({});
    const second: any = getToolHandler('sangfor_safety_selftest')!({});
    expect(first.allPass).toBe(true);
    expect(second.allPass).toBe(true);
  }, 20_000);
});
