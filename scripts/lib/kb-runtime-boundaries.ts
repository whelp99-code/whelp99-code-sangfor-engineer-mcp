import { z } from 'zod';
import { parseRuntimeJson, type RuntimeCodec } from '../../packages/shared/src/runtime-schema.js';
import type { KbPageEntry } from '../learn-kb-full-site.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(1_000_000);
const productSchema = z.enum([
  'HCI_SCP', 'HCI', 'NGFW', 'SCC', 'IAG', 'ENDPOINT_SECURE',
  'NDR', 'CYBER_COMMAND', 'HIWARE', 'OTHER',
]);
const itemTableRowSchema = z.object({
  key: z.string().min(1).max(16_384),
  value_hex: z.string().max(16 * 1024 * 1024).regex(/^(?:[A-Fa-f0-9]{2})*$/u),
}).strict();
const itemTableSchema = z.array(itemTableRowSchema).max(1_000_000);
const kbPageEntrySchema: RuntimeCodec<KbPageEntry> = z.object({
  section: textSchema,
  title: textSchema,
  type: textSchema,
  updated: z.string().max(512),
  url: z.string().min(1).max(16_384),
  product: productSchema,
  articleId: idSchema,
}).strict();

export function parseBoundaryCrawlCatalogV1(
  source: string,
): Array<{ readonly href: string; readonly text: string }> {
  return parseRuntimeJson(source, {
    schema: z.array(z.object({
      href: z.string().min(1).max(16_384),
      text: textSchema,
    }).strict()).max(1_000_000),
    schemaName: 'learning-operations.crawl-catalog.v1',
    policy: 'loud_failure',
  });
}

export function parseBoundarySafariItemTableV1(
  source: string,
): Array<{ readonly key: string; readonly value_hex: string }> {
  return parseRuntimeJson(source, {
    schema: itemTableSchema,
    schemaName: 'jm-operations.safari-item-table.v1',
    policy: 'loud_failure',
  });
}

export function parseBoundaryKbSiteMapV1(source: string): KbPageEntry[] {
  return parseRuntimeJson(source, {
    schema: z.array(kbPageEntrySchema).max(1_000_000),
    schemaName: 'learning-operations.kb-site-map.v1',
    policy: 'loud_failure',
    uniqueCollections: [{ path: [], key: 'articleId' }],
  });
}

export function parseBoundaryKbSessionItemTableV1(
  source: string,
): Array<{ readonly key: string; readonly value_hex: string }> {
  return parseRuntimeJson(source, {
    schema: itemTableSchema,
    schemaName: 'jm-operations.kb-session-item-table.v1',
    policy: 'loud_failure',
  });
}
