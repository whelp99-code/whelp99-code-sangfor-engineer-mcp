import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let listTools: () => Array<{ name: string; description: string; inputSchema: any; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listTools = (mod as any).listTools;
  getToolHandler = (mod as any).getToolHandler;
});

describe('sangfor_console_capture_evidence / sangfor_verify_capture_ledger — MCP registration', () => {
  it('sangfor_console_capture_evidence is a non-destructive write tool (writes files, never touches device config)', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_console_capture_evidence');
    expect(tool).toBeTruthy();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool!.description).toMatch(/reads console screens only; never changes device configuration/);
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(['product', 'captures']));
  });

  it('sangfor_verify_capture_ledger is read-only, non-destructive', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_verify_capture_ledger');
    expect(tool).toBeTruthy();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool!.inputSchema.required).toEqual(['runId']);
  });

  it('sangfor_verify_capture_ledger rejects a path-traversal runId before touching the filesystem', () => {
    const handler = getToolHandler('sangfor_verify_capture_ledger')!;
    const result = handler({ runId: '../../etc/passwd' }) as { error: string };
    expect(result.error).toMatch(/^INVALID_RUN_ID:/);
  });

  describe('S1 (through the MCP tool): outputDir confinement', () => {
    let evidenceRoot: string;
    const savedEvidenceRootEnv = process.env.SANGFOR_EVIDENCE_ROOT;

    beforeEach(() => {
      evidenceRoot = mkdtempSync(join(tmpdir(), 'mcp-console-evidence-root-'));
      process.env.SANGFOR_EVIDENCE_ROOT = evidenceRoot;
    });

    afterEach(() => {
      if (savedEvidenceRootEnv === undefined) delete process.env.SANGFOR_EVIDENCE_ROOT;
      else process.env.SANGFOR_EVIDENCE_ROOT = savedEvidenceRootEnv;
      rmSync(evidenceRoot, { recursive: true, force: true });
    });

    it('sangfor_console_capture_evidence rejects an explicit outputDir outside the evidence root', async () => {
      const handler = getToolHandler('sangfor_console_capture_evidence')!;
      const outsideDir = join(tmpdir(), 'mcp-console-evidence-outside');
      await expect(
        Promise.resolve(handler({ product: 'IAG', outputDir: outsideDir, captures: [{ reqId: '01', menuLabel: 'x' }] })),
      ).rejects.toThrow(/^CAPTURE_DIR_OUTSIDE_ROOT:/);
    });
  });

  it('both tools appear in the "full" tools/list and sangfor_verify_capture_ledger also appears in "advisor"', async () => {
    const { handle } = await import('../apps/mcp-server/src/index.js') as any;
    const full = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const fullNames = full.result.tools.map((t: any) => t.name);
    expect(fullNames).toContain('sangfor_console_capture_evidence');
    expect(fullNames).toContain('sangfor_verify_capture_ledger');

    const saved = process.env.SANGFOR_TOOL_PROFILE;
    try {
      process.env.SANGFOR_TOOL_PROFILE = 'advisor';
      const advisor = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const advisorNames = advisor.result.tools.map((t: any) => t.name);
      expect(advisorNames).toContain('sangfor_verify_capture_ledger');
      expect(advisorNames).not.toContain('sangfor_console_capture_evidence');

      process.env.SANGFOR_TOOL_PROFILE = 'operator';
      const operator = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const operatorNames = operator.result.tools.map((t: any) => t.name);
      expect(operatorNames).toContain('sangfor_console_capture_evidence');
    } finally {
      if (saved === undefined) delete process.env.SANGFOR_TOOL_PROFILE;
      else process.env.SANGFOR_TOOL_PROFILE = saved;
    }
  });
});
