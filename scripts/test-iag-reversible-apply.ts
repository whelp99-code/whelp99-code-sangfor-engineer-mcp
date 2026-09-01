#!/usr/bin/env node
import process from 'node:process';
import { IagMockCampaignError, runMockIagCampaign } from './lib/iag-reversible-campaign.js';

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrl = valueAfter(args, '--base-url');
  const exception = valueAfter(args, '--exception');
  const known = new Set(['--base-url', baseUrl, '--exception', exception, '--restore']);
  if (baseUrl === undefined || exception === undefined || !args.includes('--restore') || args.some((arg) => !known.has(arg))) {
    throw new IagMockCampaignError('IAG_MOCK_ARGUMENTS_INVALID');
  }
  const report = await runMockIagCampaign({ baseUrl, exception, restore: true });
  process.stdout.write(`IAG_REVERSIBLE_APPLY_PASS\n${JSON.stringify(report)}\n`);
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch - CLI boundary emits only a stable redacted code.
  process.stderr.write(`${error instanceof IagMockCampaignError ? error.code : 'IAG_MOCK_CAMPAIGN_FAILED'}\n`);
  process.exitCode = 1;
}
