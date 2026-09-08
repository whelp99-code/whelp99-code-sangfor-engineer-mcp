import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  CAMPAIGN_PRODUCTS,
  buildCapabilityCampaign,
  buildProductEvidenceCensus,
  buildRepoCoverageContext,
  fetchBridgeToolRegistry,
  loadCanonicalWorkAtomCatalog,
  type CampaignProduct,
} from '@sangfor/competency';
import { CapabilityEvidenceCliError } from './capability-evidence-cli-errors.js';

export type CampaignCliCommand =
  | { readonly kind: 'campaign_scaffold'; readonly product: CampaignProduct; readonly outputRoot: string }
  | { readonly kind: 'census' };

export function parseCampaignCliCommand(args: readonly string[]): CampaignCliCommand | undefined {
  if (args.length === 2 && args[0] === 'census' && args[1] === '--json') return { kind: 'census' };
  if (args.length !== 6 || args[0] !== 'campaign' || args[1] !== 'scaffold'
    || args[2] !== '--product' || args[4] !== '--output') return undefined;
  const product = args[3];
  const outputRoot = args[5];
  if (outputRoot === undefined || (product !== CAMPAIGN_PRODUCTS[0] && product !== CAMPAIGN_PRODUCTS[1]
    && product !== CAMPAIGN_PRODUCTS[2] && product !== CAMPAIGN_PRODUCTS[3])) return undefined;
  return { kind: 'campaign_scaffold', product, outputRoot };
}

export async function runCampaignCliCommand(command: CampaignCliCommand): Promise<void> {
  if (command.kind === 'census') {
    const registry = await fetchBridgeToolRegistry();
    if (!registry.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
    const coverage = buildRepoCoverageContext(registry.toolNames);
    if (!coverage.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
    const loaded = loadCanonicalWorkAtomCatalog(coverage.context.catalogRoot);
    if (!loaded.ok) throw new CapabilityEvidenceCliError({ code: 'catalog_authority_invalid', path: [] });
    process.stdout.write(`${JSON.stringify(buildProductEvidenceCensus(loaded.catalog, coverage.context))}\n`);
    return;
  }
  let outputRoot: string;
  try {
    const stat = lstatSync(command.outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CapabilityEvidenceCliError({ code: 'campaign_output_invalid', path: [] });
    outputRoot = realpathSync(command.outputRoot);
  } catch (error) {
    if (error instanceof CapabilityEvidenceCliError) throw error;
    if (error instanceof Error) throw new CapabilityEvidenceCliError({ code: 'campaign_output_invalid', path: [] });
    throw error;
  }
  const loaded = loadCanonicalWorkAtomCatalog();
  if (!loaded.ok) throw new CapabilityEvidenceCliError({ code: 'catalog_authority_invalid', path: [] });
  const target = join(outputRoot, `capability-campaign-${command.product}.v1.json`);
  const temporary = join(outputRoot, `.capability-campaign-${process.pid}-${randomUUID()}.tmp`);
  const source = `${JSON.stringify(buildCapabilityCampaign(command.product, loaded.catalog), null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    const bytes = Buffer.from(source, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
  } catch (error) {
    if (error instanceof Error) throw new CapabilityEvidenceCliError({ code: 'campaign_output_exists', path: [] });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!(error instanceof Error)) throw error; }
  }
  process.stdout.write('CAPABILITY_CAMPAIGN_SCAFFOLD_PASS\n');
}
