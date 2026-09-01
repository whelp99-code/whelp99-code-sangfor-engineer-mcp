import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTools } from '../apps/mcp-server/src/index.js';
import { signApprovalToken, type SignedApproval } from '../packages/sangfor-operator/src/approval.js';
import {
  BRIDGE_APPROVAL_ACTION_TYPE,
  authorizeToolCall,
} from '../packages/sangfor-operator/src/tool-authorization.js';
import {
  IagEvidenceBootstrapInputError,
  parseIagEvidenceBootstrapArgs,
  readIagEvidenceBootstrapApproval,
} from '../scripts/lib/iag-evidence-bootstrap-input.js';

process.env.MCP_NO_SERVE = '1';
const BRIDGE_SECRET = 'iag-bootstrap-bridge-secret-32-bytes';
const BOOTSTRAP_TOOL_NAME = 'sangfor_iag_evidence_bootstrap';
const ENTRYPOINT = 'scripts/iag-evidence-bootstrap.ts';

let root = '';

type EntrypointResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs the shipped entrypoint the way an operator does, so exit code and streams are the contract. */
async function runEntrypoint(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<EntrypointResult> {
  const child = spawn('pnpm', ['exec', 'tsx', ENTRYPOINT, ...args], { cwd: process.cwd(), env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await once(child, 'close');
  return { status: child.exitCode, stdout, stderr };
}

/** A bridge approval that verifies, so the refusal under test cannot be an approval failure. */
function bridgeApproval(): SignedApproval {
  const fields: Omit<SignedApproval, 'approvalToken'> = {
    approvedBy: 'operator-cli', changeTicketId: 'CHG-O1-CLI', rollbackPlanId: 'RB-O1-CLI',
    nonce: 'bootstrap-exposure-1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorityEpoch: 0,
  };
  const action = { type: BRIDGE_APPROVAL_ACTION_TYPE, target: BOOTSTRAP_TOOL_NAME };
  return { ...fields, approvalToken: signApprovalToken(BRIDGE_SECRET, action, fields) };
}

/** Reads every shipped app/bridge module so exposure is proven from source, not a registry snapshot. */
function appModuleSources(): readonly string[] {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) sources.push(readFileSync(path, 'utf8'));
    }
  };
  visit(join(process.cwd(), 'apps'));
  return sources;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-bootstrap-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('O1 IAG evidence bootstrap CLI grammar', () => {
  it('Given strict real-lab arguments, When parsed, Then a lab run command carries every reference', () => {
    // Given
    const args = [
      '--manifest', '/lab/manifest.json', '--validation-context', '/lab/context.json',
      '--evidence-root', '/lab/evidence', '--ledger', '/lab/promotion.jsonl',
      '--origin', 'https://iag.lab.example.invalid', '--action-kind', 'single_url_exception',
      '--approval', '/lab/approval.json',
    ];

    // When
    const parsed = parseIagEvidenceBootstrapArgs(args);

    // Then
    expect(parsed).toEqual({
      kind: 'run',
      references: {
        manifestPath: '/lab/manifest.json', validationContextPath: '/lab/context.json',
        evidenceRoot: '/lab/evidence', ledgerPath: '/lab/promotion.jsonl',
      },
      originId: 'https://iag.lab.example.invalid',
      actionKind: 'single_url_exception',
      approvalPath: '/lab/approval.json',
    });
  });

  it('Given an equivalent mixed-case default-port origin, When parsed, Then the command carries the canonical origin', () => {
    const parsed = parseIagEvidenceBootstrapArgs([
      '--manifest', '/lab/manifest.json', '--validation-context', '/lab/context.json',
      '--evidence-root', '/lab/evidence', '--ledger', '/lab/promotion.jsonl',
      '--origin', 'HTTPS://IAG.LAB.EXAMPLE.INVALID:443', '--action-kind', 'single_url_exception',
    ]);

    expect(parsed).toMatchObject({
      kind: 'run',
      originId: 'https://iag.lab.example.invalid',
    });
  });

  it('Given only --help, When parsed, Then help is requested rather than a run', () => {
    expect(parseIagEvidenceBootstrapArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it.each([
    ['an unknown flag', ['--manifest', '/lab/m.json', '--wat', 'x']],
    ['a broadened action kind', ['--action-kind', 'policy_bundle']],
    ['help mixed with an unknown flag', ['--help', '--oops']],
    ['a flag with no value', ['--manifest']],
    ['a flag whose value is another flag', ['--manifest', '--origin', 'https://iag.invalid']],
    ['an unknown flag-shaped origin value', [
      '--manifest', '/lab/manifest.json', '--validation-context', '/lab/context.json',
      '--evidence-root', '/lab/evidence', '--ledger', '/lab/promotion.jsonl',
      '--origin', '--unknown-value', '--action-kind', 'single_url_exception',
    ]],
    ['a non-origin URL', [
      '--manifest', '/lab/manifest.json', '--validation-context', '/lab/context.json',
      '--evidence-root', '/lab/evidence', '--ledger', '/lab/promotion.jsonl',
      '--origin', 'https://iag.invalid/path', '--action-kind', 'single_url_exception',
    ]],
    ['a duplicated reference', ['--manifest', '/a.json', '--manifest', '/b.json']],
    ['a bare positional argument', ['bootstrap']],
    ['an execution flag', ['--allow-real-execution', 'true']],
    ['no arguments at all', []],
  ])('Given %s, When parsed, Then the CLI refuses with a typed code', (_name, args) => {
    expect(() => parseIagEvidenceBootstrapArgs(args)).toThrow(IagEvidenceBootstrapInputError);
  });

  it('Given complete references but no action kind, When parsed, Then it refuses rather than defaulting', () => {
    const args = [
      '--manifest', '/lab/manifest.json', '--validation-context', '/lab/context.json',
      '--evidence-root', '/lab/evidence', '--ledger', '/lab/promotion.jsonl',
      '--origin', 'https://iag.lab.example.invalid',
    ];

    expect(() => parseIagEvidenceBootstrapArgs(args)).toThrow(IagEvidenceBootstrapInputError);
  });
});

describe('O1 IAG evidence bootstrap approval document loading', () => {
  it('Given a well formed approval document, When it is read, Then it is handed on untouched as untrusted JSON', () => {
    // Given
    const path = join(root, 'approval.json');
    writeFileSync(path, JSON.stringify({ approvedBy: 'operator-cli', nonce: 'cli-1' }));

    // When
    const document = readIagEvidenceBootstrapApproval(path);

    // Then
    expect(document).toEqual({ approvedBy: 'operator-cli', nonce: 'cli-1' });
  });

  it.each([
    ['an absent document', 'absent-approval.json', undefined],
    ['a malformed document', 'malformed-approval.json', '{"approvedBy":'],
    ['a directory in place of a document', '', undefined],
  ])('Given %s, When it is read, Then it refuses with a typed code', (_name, name, source) => {
    const path = join(root, name);
    if (source !== undefined) writeFileSync(path, source);

    expect(() => readIagEvidenceBootstrapApproval(path)).toThrow(IagEvidenceBootstrapInputError);
  });
});

describe('O1 IAG evidence bootstrap default CLI composition', () => {
  it('Given sanitized absent references, When the entrypoint runs, Then it exits nonzero with a typed refusal', async () => {
    // Given
    const noncePath = join(root, 'cli-nonces.json');

    // When
    const result = await runEntrypoint([
      '--manifest', join(root, 'absent-manifest.json'),
      '--validation-context', join(root, 'absent-context.json'),
      '--evidence-root', join(root, 'absent-evidence'),
      '--ledger', join(root, 'absent-promotion.jsonl'),
      '--origin', 'https://iag.lab.example.invalid',
      '--action-kind', 'single_url_exception',
    ], { ...process.env, SANGFOR_NONCE_STORE_PATH: noncePath, SANGFOR_COMPETENCY_ROOT: undefined });

    // Then
    expect(result).toMatchObject({ status: 1, stdout: '', stderr: 'AUTHORITY_UNAVAILABLE\n' });
    expect(existsSync(noncePath)).toBe(false);
  }, 60_000);

  it('Given an unknown flag, When the entrypoint runs, Then it refuses without touching authority', async () => {
    const result = await runEntrypoint(['--not-a-flag', 'x']);

    expect(result).toMatchObject({ status: 1, stderr: 'IAG_BOOTSTRAP_ARGUMENTS_INVALID\n' });
  }, 60_000);

  it('Given --help, When the entrypoint runs, Then it prints usage and exits zero', async () => {
    const result = await runEntrypoint(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--action-kind');
  }, 60_000);
});

describe('O1 IAG evidence bootstrap exposure boundary', () => {
  it('Given a verifying bridge approval, When a bootstrap tool call is attempted, Then no tool route exists', async () => {
    const decision = await authorizeToolCall({
      name: BOOTSTRAP_TOOL_NAME, toolListResult: { tools: listTools() },
      enforceWhitelist: false, approval: bridgeApproval(), approvalSecret: BRIDGE_SECRET,
    });

    expect(decision).toMatchObject({ allow: false, status: 403 });
  });

  it('Given the shipped tool inventory, When names are scanned, Then none exposes a bootstrap route', () => {
    expect(listTools().filter(({ name }) => name.toLowerCase().includes('bootstrap'))).toEqual([]);
  });

  it('Given every shipped app module, When scanned, Then none imports the bootstrap CLI', () => {
    const referencing = appModuleSources().filter((source) => (
      source.includes('iag-evidence-bootstrap-') || source.includes(ENTRYPOINT)
    ));

    expect(referencing).toEqual([]);
  });
});
