type ToolListResult = {
  tools?: Array<{
    name?: unknown;
    annotations?: {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
    };
  }>;
};

export function findToolAnnotations(toolListResult: unknown, name: string) {
  const tools = (toolListResult as ToolListResult)?.tools;
  if (!Array.isArray(tools)) return null;
  const tool = tools.find((entry) => entry.name === name);
  const annotations = tool?.annotations;
  if (
    typeof annotations?.readOnlyHint !== 'boolean' ||
    typeof annotations.destructiveHint !== 'boolean'
  ) {
    return null;
  }
  return annotations;
}

export function isToolAllowedByAnnotations(toolListResult: unknown, name: string): boolean {
  const annotations = findToolAnnotations(toolListResult, name);
  return annotations?.readOnlyHint === true && annotations.destructiveHint === false;
}

export interface ToolAuthDecision {
  allow: boolean;
  status?: number;
  error?: string;
}

/**
 * Single source of truth for whether an incoming /tools/call is authorized.
 * Invariants (regression-pinned):
 *  - unknown/missing annotations  → refuse (fail-closed)
 *  - destructiveHint              → refuse ALWAYS, even with the whitelist off
 *  - non-read-only ("write") tool → refuse unless the whitelist is explicitly disabled
 *  - read-only tool               → allow
 */
export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;
}): ToolAuthDecision {
  const { name, toolListResult, enforceWhitelist } = params;
  const annotations = findToolAnnotations(toolListResult, name);
  if (!annotations) {
    return { allow: false, status: 403, error: `Tool annotations unavailable; refusing call: ${name}` };
  }
  if (annotations.destructiveHint) {
    return { allow: false, status: 403, error: `Destructive tool refused by MCP annotations: ${name}` };
  }
  if (enforceWhitelist && !isToolAllowedByAnnotations(toolListResult, name)) {
    return { allow: false, status: 403, error: `Tool is not annotated read-only: ${name}` };
  }
  return { allow: true };
}
