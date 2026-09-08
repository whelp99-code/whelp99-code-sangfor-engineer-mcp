export type ToolHandler = {
  bivarianceHack(args: unknown): unknown | Promise<unknown>;
}['bivarianceHack'];

export type JsonSchemaObject = Record<string, unknown>;

export type ToolDefinition = {
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly handler: ToolHandler;
};

export type ToolCatalogEntry = readonly [name: string, definition: ToolDefinition];

export type AdvertisedTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
  };
  readonly category: string;
};

export const TOOL_PROFILES = ['advisor', 'operator', 'full'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export type ToolArgumentIssue = {
  readonly code: string;
  readonly path: string;
  readonly schemaPath: string;
};

export type ToolArgumentValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ToolArgumentIssue[] };

export type ToolRuntime = {
  readonly entries: readonly ToolCatalogEntry[];
  readonly validatorCount: number;
  readonly definition: (name: string) => ToolDefinition | undefined;
  readonly validate: (name: string, args: unknown) => ToolArgumentValidation;
};
