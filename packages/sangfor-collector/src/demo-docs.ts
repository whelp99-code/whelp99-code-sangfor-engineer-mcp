import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductCode } from '@sangfor/shared';

export const DEMO_DOCS_DIR = 'data/demo-docs';

export const DEMO_DOC_PRODUCTS: Record<string, { product: ProductCode; version?: string }> = {
  'hci-storage-network.md': { product: 'HCI', version: '6.11' },
  'iag-policy-baseline.md': { product: 'IAG' },
  'endpoint-secure-rollout.md': { product: 'ENDPOINT_SECURE' },
  'cyber-command-onboarding.md': { product: 'CYBER_COMMAND' }
};

export interface DemoDocIngestTarget {
  filePath: string;
  product: ProductCode;
  version?: string;
  title: string;
}

export function listDemoDocTargets(dir = DEMO_DOCS_DIR): DemoDocIngestTarget[] {
  if (!existsSync(dir)) return [];
  const targets: DemoDocIngestTarget[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const meta = DEMO_DOC_PRODUCTS[file];
    if (!meta) continue;
    targets.push({
      filePath: join(dir, file),
      product: meta.product,
      version: meta.version,
      title: file.replace(/\.md$/, '')
    });
  }
  return targets;
}
