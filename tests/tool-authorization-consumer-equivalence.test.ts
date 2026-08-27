import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { createBridgeServer, type McpRequestFn } from '../apps/http-bridge/src/server.js';
import { signApprovalToken, type SignedApproval } from '../packages/sangfor-operator/src/approval.js';
import type { ToolAuthDecision } from '../packages/sangfor-operator/src/tool-authorization.js';
import { authorizeSafetySelftestToolCall } from '../apps/mcp-server/src/tool-authorization-consumer.js';

const SECRET = 'consumer-equivalence-secret';
const TOOL_LIST = {
  tools: [
    { name: 'read', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'write', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'destructive', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'missing-annotations', annotations: {} },
  ],
};

type MatrixCase = {
  readonly name: string;
  readonly tool: string;
  readonly enforceWhitelist: boolean;
  readonly remoteBind?: boolean;
  readonly allowRemoteWrite?: boolean;
  readonly approval?: 'valid' | 'invalid' | 'expired' | 'replayed';
};

const CASES: readonly MatrixCase[] = [
  { name: 'read', tool: 'read', enforceWhitelist: true },
  { name: 'write with whitelist disabled', tool: 'write', enforceWhitelist: false },
  { name: 'destructive with missing approval', tool: 'destructive', enforceWhitelist: false },
  { name: 'write refused by whitelist', tool: 'write', enforceWhitelist: true },
  { name: 'valid approved write', tool: 'write', enforceWhitelist: true, approval: 'valid' },
  { name: 'invalid approval', tool: 'write', enforceWhitelist: true, approval: 'invalid' },
  { name: 'expired approval', tool: 'write', enforceWhitelist: true, approval: 'expired' },
  { name: 'replayed approval', tool: 'write', enforceWhitelist: true, approval: 'replayed' },
  { name: 'remote write refusal', tool: 'write', enforceWhitelist: false, remoteBind: true },
  { name: 'nonloopback approved write refusal', tool: 'write', enforceWhitelist: true, remoteBind: true, approval: 'valid' },
  { name: 'remote write explicit allow', tool: 'write', enforceWhitelist: false, remoteBind: true, allowRemoteWrite: true },
  { name: 'missing annotations', tool: 'missing-annotations', enforceWhitelist: false },
];

const temporaryRoots: string[] = [];
const originalEnvironment = { ...process.env };

afterAll(() => {
  process.env = { ...originalEnvironment };
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function mint(tool: string, kind: NonNullable<MatrixCase['approval']>): SignedApproval {
  const expiresAt = new Date(Date.now() + (kind === 'expired' ? -1_000 : 60_000)).toISOString();
  const base = {
    approvedBy: 'equivalence-test',
    changeTicketId: 'CHG-35',
    rollbackPlanId: 'RB-35',
    nonce: randomBytes(12).toString('hex'),
    expiresAt,
    authorityEpoch: 0,
  };
  const signingSecret = kind === 'invalid' ? 'wrong-secret' : SECRET;
  return {
    ...base,
    approvalToken: signApprovalToken(
      signingSecret,
      { type: 'bridge.tool-call', target: tool },
      base,
    ),
  };
}

function fakeMcpRequest(): McpRequestFn {
  return async (method) => method === 'tools/list'
    ? { jsonrpc: '2.0', result: TOOL_LIST }
    : { jsonrpc: '2.0', result: { structuredContent: { dispatched: true } } };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Bridge fixture did not bind an ephemeral TCP port.');
  return `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
}

async function bridgeDecision(
  matrixCase: MatrixCase,
  approval: SignedApproval | undefined,
): Promise<ToolAuthDecision> {
  process.env.WHELP99_ENFORCE_SAFE_TOOLS = matrixCase.enforceWhitelist ? 'true' : 'false';
  const server = createBridgeServer({
    mcpRequest: fakeMcpRequest(),
    remoteBind: matrixCase.remoteBind,
    allowRemoteWrite: matrixCase.allowRemoteWrite,
  });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: matrixCase.tool, arguments: {}, approval }),
    });
    if (response.status === 200) return { allow: true };
    const body: unknown = await response.json();
    const error = typeof body === 'object' && body !== null && 'error' in body
      && typeof body.error === 'string' ? body.error : undefined;
    return { allow: false, status: response.status, error };
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
      if (error !== undefined) rejectClose(error);
      else resolveClose();
    }));
  }
}

async function mcpDecision(
  matrixCase: MatrixCase,
  approval: SignedApproval | undefined,
): Promise<ToolAuthDecision> {
  return authorizeSafetySelftestToolCall({
    name: matrixCase.tool,
    toolListResult: TOOL_LIST,
    enforceWhitelist: matrixCase.enforceWhitelist,
    remoteBind: matrixCase.remoteBind,
    allowRemoteWrite: matrixCase.allowRemoteWrite,
    approval,
    approvalSecret: approval === undefined ? undefined : SECRET,
  });
}

describe('bridge and MCP tool-authorization consumers', () => {
  it.each(CASES)('returns equivalent machine decisions for $name', async (matrixCase) => {
    // Given isolated nonce stores and semantically identical approvals for each
    // consumer, with replay fixtures consumed before the observed action.
    const bridgeRoot = mkdtempSync(join(tmpdir(), 'task-35-bridge-'));
    const mcpRoot = mkdtempSync(join(tmpdir(), 'task-35-mcp-'));
    temporaryRoots.push(bridgeRoot, mcpRoot);
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    const approvalKind = matrixCase.approval;
    const approval = approvalKind === undefined ? undefined : mint(matrixCase.tool, approvalKind);
    const bridgeApproval = approval;
    const mcpApproval = approval;

    if (approvalKind === 'replayed') {
      process.env.SANGFOR_NONCE_STORE_PATH = join(bridgeRoot, 'nonces.json');
      await bridgeDecision(matrixCase, bridgeApproval);
      process.env.SANGFOR_NONCE_STORE_PATH = join(mcpRoot, 'nonces.json');
      await mcpDecision(matrixCase, mcpApproval);
    }

    // When both real app consumers authorize the same semantic case.
    process.env.SANGFOR_NONCE_STORE_PATH = join(bridgeRoot, 'nonces.json');
    const bridge = await bridgeDecision(matrixCase, bridgeApproval);
    process.env.SANGFOR_NONCE_STORE_PATH = join(mcpRoot, 'nonces.json');
    const mcp = await mcpDecision(matrixCase, mcpApproval);

    // Then their machine-consumed allow/status/error decisions are identical.
    expect(bridge).toEqual(mcp);
  });
});
