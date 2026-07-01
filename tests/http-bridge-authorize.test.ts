import { describe, it, expect } from 'vitest';
import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';

const toolList = {
  tools: [
    { name: 'ro', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'write', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'destructive', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'noannot', annotations: {} },
  ],
};

describe('authorizeToolCall — http-bridge runtime authorization', () => {
  it('allows a read-only tool regardless of the whitelist toggle', () => {
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: true }).allow).toBe(true);
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });

  it('ALWAYS refuses a destructive tool, even when the whitelist is disabled', () => {
    const off = authorizeToolCall({ name: 'destructive', toolListResult: toolList, enforceWhitelist: false });
    expect(off.allow).toBe(false);
    expect(off.status).toBe(403);
    expect(off.error).toMatch(/destructive/i);
  });

  it('refuses a write (non-read-only) tool when the whitelist is enforced', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
  });

  it('permits a write tool only when the whitelist is explicitly disabled', () => {
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });

  it('refuses a tool whose annotations are unavailable (fail-closed)', () => {
    const d = authorizeToolCall({ name: 'noannot', toolListResult: toolList, enforceWhitelist: false });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/annotations unavailable/i);
  });
});
