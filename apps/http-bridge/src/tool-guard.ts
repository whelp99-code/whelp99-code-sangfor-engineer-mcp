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
