import type { AdvertisedTool, ToolProfile } from './mcp-contracts.js';

type CatalogView = {
  readonly listTools: () => readonly AdvertisedTool[];
  readonly listToolsForProfile: (profile?: ToolProfile) => readonly AdvertisedTool[];
};

let configuredView: CatalogView | undefined;

export function configureToolCatalogView(view: CatalogView): void {
  configuredView = view;
}

function requiredView(): CatalogView {
  if (configuredView === undefined) throw new Error('MCP_TOOL_CATALOG_VIEW_NOT_CONFIGURED');
  return configuredView;
}

export function listedTools(): readonly AdvertisedTool[] {
  return requiredView().listTools();
}

export function listedToolsForProfile(profile?: ToolProfile): readonly AdvertisedTool[] {
  return requiredView().listToolsForProfile(profile);
}
