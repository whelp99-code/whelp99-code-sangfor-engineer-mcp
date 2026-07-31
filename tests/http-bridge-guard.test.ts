import { describe, expect, it } from 'vitest';
import { isToolAllowedByAnnotations } from '../apps/http-bridge/src/tool-guard.js';

describe('http bridge annotation guard', () => {
  it('rejects tools marked destructive by MCP annotations', () => {
    const toolListResult = {
      tools: [
        { name: 'sangfor_apply_change', annotations: { destructiveHint: true, readOnlyHint: false } },
      ],
    };

    expect(isToolAllowedByAnnotations(toolListResult, 'sangfor_apply_change')).toBe(false);
  });

  it('allows tools explicitly marked read-only and non-destructive', () => {
    const toolListResult = {
      tools: [
        { name: 'sangfor_products', annotations: { destructiveHint: false, readOnlyHint: true } },
      ],
    };

    expect(isToolAllowedByAnnotations(toolListResult, 'sangfor_products')).toBe(true);
  });

  it('fails closed when annotations are missing or tool is unknown', () => {
    const toolListResult = {
      tools: [
        { name: 'sangfor_unknown_annotations' },
      ],
    };

    expect(isToolAllowedByAnnotations(toolListResult, 'sangfor_unknown_annotations')).toBe(false);
    expect(isToolAllowedByAnnotations(toolListResult, 'sangfor_not_listed')).toBe(false);
  });
});
