/**
 * Blocker 3 — coverage grounds on the ADVERTISED tool set, not the internal map.
 *
 * `Object.keys(tools)` is every tool the module defines, including ones the
 * active profile deliberately hides. Grounding on it lets an advisor-profile
 * server certify a replacement against a tool no client on that server can call
 * — a rate for a capability that is not actually reachable. The census that
 * grounds the claim must be the census the server advertises.
 */
import { beforeAll, describe, expect, it } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

interface AdvertisedTool { readonly name: string; readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean } }
let listToolsForProfile: (profile?: 'advisor' | 'operator' | 'full') => readonly AdvertisedTool[];
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listToolsForProfile = mod.listToolsForProfile as typeof listToolsForProfile;
  getToolHandler = mod.getToolHandler as typeof getToolHandler;
});

describe('sangfor_field_engineer_coverage grounds on the advertised profile census', () => {
  it('Given the advisor profile, When the advertised census is taken, Then it is a strict subset that hides write tools', () => {
    const full = listToolsForProfile('full');
    const advisor = listToolsForProfile('advisor');

    expect(advisor.length).toBeLessThan(full.length);
    expect(advisor.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
  });

  it('Given the advisor profile hides a write tool, When coverage runs under that profile, Then the hidden tool cannot ground a claim', () => {
    const advisorNames = new Set(listToolsForProfile('advisor').map((t) => t.name));
    const hidden = listToolsForProfile('full').find((t) => !advisorNames.has(t.name));
    expect(hidden).toBeDefined();
    if (!hidden) return;

    const previousProfile = process.env.SANGFOR_TOOL_PROFILE;
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    try {
      const handler = getToolHandler('sangfor_field_engineer_coverage');
      expect(handler).toBeDefined();
      if (!handler) return;

      const result = handler({}) as { ok: boolean; groundedToolCount?: number };
      // Whatever the catalog verdict is, the grounding census must be the
      // advisor one — strictly smaller than the full internal tool map.
      expect(result.groundedToolCount).toBe(advisorNames.size);
      expect(result.groundedToolCount).toBeLessThan(listToolsForProfile('full').length);
    } finally {
      if (previousProfile === undefined) delete process.env.SANGFOR_TOOL_PROFILE;
      else process.env.SANGFOR_TOOL_PROFILE = previousProfile;
    }
  });

  it('Given the full profile, When coverage runs, Then the grounding census matches the full advertised list', () => {
    const previousProfile = process.env.SANGFOR_TOOL_PROFILE;
    process.env.SANGFOR_TOOL_PROFILE = 'full';
    try {
      const handler = getToolHandler('sangfor_field_engineer_coverage');
      if (!handler) return;
      const result = handler({}) as { groundedToolCount?: number };
      expect(result.groundedToolCount).toBe(listToolsForProfile('full').length);
    } finally {
      if (previousProfile === undefined) delete process.env.SANGFOR_TOOL_PROFILE;
      else process.env.SANGFOR_TOOL_PROFILE = previousProfile;
    }
  });
});
