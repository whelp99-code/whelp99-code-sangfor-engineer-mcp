import { normalizeProduct, nowId } from '@sangfor/shared';
import type { ProductCode } from '@sangfor/shared';
import { LEGACY_ADAPTERS } from './product-catalog.js';
import type {
  AutomationProductCode,
  ConfigSource,
  ProductAdapter,
  ProductAutomationInput,
  ProductConfigSnapshot,
} from './types.js';

export function normalizeAutomationProduct(input?: string): AutomationProductCode {
  const raw = (input ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return 'HCI_SCP';
  for (const adapter of Object.values(LEGACY_ADAPTERS)) {
    if (adapter.product.toLowerCase() === normalized) return adapter.product;
    if (adapter.aliases.some(alias => normalized === alias.toLowerCase().replace(/[\s-]+/g, '_'))) return adapter.product;
  }
  const sharedProduct: ProductCode = normalizeProduct(input);
  if (sharedProduct === 'HCI' || sharedProduct === 'HCI_SCP') return 'HCI_SCP';
  if (sharedProduct === 'CYBER_COMMAND' || sharedProduct === 'NDR') return 'NDR';
  if (sharedProduct === 'IAG' || sharedProduct === 'ENDPOINT_SECURE') return sharedProduct;
  if (sharedProduct === 'NGFW' || sharedProduct === 'SCC' || sharedProduct === 'HIWARE') {
    throw new Error(`UNSUPPORTED_PRODUCT: ${sharedProduct} has no automation adapter.`);
  }
  return 'HCI_SCP';
}

export function getProductAdapter(product?: string): ProductAdapter {
  return LEGACY_ADAPTERS[normalizeAutomationProduct(product)];
}

export function listProductAdapters(): ProductAdapter[] {
  return Object.values(LEGACY_ADAPTERS);
}

export function discoverProductConsole(input: ProductAutomationInput) {
  const adapter = getProductAdapter(input.product);
  return {
    id: nowId('discover'),
    product: adapter.product,
    targetUrl: input.targetUrl,
    version: input.version,
    strategy: adapter.strategy,
    apiLikely: adapter.apiLikely,
    apiCatalogStatus: adapter.apiCatalogStatus,
    authMethods: adapter.authMethods,
    menuRoutes: adapter.menuRoutes,
    capabilities: adapter.capabilities,
    nextStep: adapter.apiCatalogStatus === 'ready'
      ? 'Use API catalog first, then verify with WebUI evidence.'
      : 'Run read-only WebUI traversal and capture network/API discovery evidence.'
  };
}

export function collectProductConfig(input: ProductAutomationInput): ProductConfigSnapshot {
  const adapter = getProductAdapter(input.product);
  const source = chooseSource(adapter, input.preferApi);
  const sectionIds = unique(adapter.capabilities.flatMap(c => c.collectSections));
  return {
    id: nowId('snapshot'),
    product: adapter.product,
    strategy: adapter.strategy,
    source,
    targetUrl: input.targetUrl,
    version: input.version,
    collectedAt: new Date().toISOString(),
    sections: sectionIds.map(id => ({
      id,
      source,
      status: adapter.apiCatalogStatus === 'document_required' && source !== 'webui' ? 'needs_discovery' : 'collectable',
      evidence: buildEvidenceHints(adapter, id, source)
    })),
    safety: {
      readOnly: true,
      mutationBlocked: true
    }
  };
}

function chooseSource(adapter: ProductAdapter, preferApi?: boolean): ConfigSource {
  if (adapter.strategy === 'api-first' && preferApi !== false) return 'api';
  if (adapter.strategy === 'hybrid') return preferApi === false ? 'webui' : 'hybrid';
  if (adapter.apiCatalogStatus === 'ready') return 'webui';
  return 'api-discovery';
}

function catalogHint(adapter: ProductAdapter): string {
  if (adapter.apiCatalogStatus !== 'ready') return 'capture=webui_screenshot_and_network_discovery';
  if (adapter.product === 'HCI_SCP') return 'api_catalog=scp_openapi_v6.10/v6.1';
  if (adapter.product === 'IAG') return 'webui_catalog=iag_v1';
  if (adapter.product === 'ENDPOINT_SECURE') return 'webui_catalog=endpoint_secure_v1';
  if (adapter.product === 'NDR') return 'api_catalog=ndr_third_party_rest_v1';
  return 'catalog=ready';
}

function buildEvidenceHints(adapter: ProductAdapter, section: string, source: ConfigSource): string[] {
  const menu = adapter.capabilities.find(cap => cap.collectSections.includes(section))?.menuPath.join(' > ');
  const hints = [`section=${section}`, `source=${source}`];
  if (menu) hints.push(`menu=${menu}`);
  hints.push(catalogHint(adapter));
  return hints;
}


function unique(values: string[]): string[] {
  return [...new Set(values)];
}
