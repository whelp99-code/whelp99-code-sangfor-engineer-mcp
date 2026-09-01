#!/usr/bin/env node
import process from 'node:process';
import {
  CapabilityEvidenceGroundingError,
  PromotionLedgerUnavailableError,
  capabilityPromotionCliOutput,
} from '@sangfor/competency';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';
import {
  CapabilityEvidenceCliError,
  refusalOutcome,
} from './lib/capability-evidence-cli-errors.js';
import {
  parseExistingCommand,
  runExistingCommand,
} from './lib/capability-evidence-cli-existing.js';
import {
  parseCampaignCliCommand,
  runCampaignCliCommand,
} from './lib/capability-evidence-cli-campaign.js';
import {
  parseStaleCliCommand,
  runStaleCliCommand,
} from './lib/capability-evidence-cli-stale.js';
import { parseHelpCommand, printHelp } from './lib/capability-evidence-cli-help.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const helpCommand = parseHelpCommand(args);
  if (helpCommand !== undefined) {
    printHelp(helpCommand);
    return;
  }
  const existingCommand = parseExistingCommand(args);
  if (existingCommand !== undefined) {
    await runExistingCommand(existingCommand);
    return;
  }
  const campaignCommand = parseCampaignCliCommand(args);
  if (campaignCommand !== undefined) {
    await runCampaignCliCommand(campaignCommand);
    return;
  }
  const staleCommand = parseStaleCliCommand(args);
  if (staleCommand !== undefined) {
    await runStaleCliCommand(staleCommand);
    return;
  }
  throw new CapabilityEvidenceCliError({ code: 'invalid_arguments', path: [] });
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch - top-level CLI boundary emits a redacted machine refusal.
  const command = process.argv[2];
  const refusalMessage = command === 'verify'
    ? 'CAPABILITY_EVIDENCE_REFUSED'
    : command === 'promote' ? 'CAPABILITY_PROMOTION_REFUSED' : 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED';
  if (error instanceof PromotionLedgerUnavailableError) {
    const output = capabilityPromotionCliOutput({ status: 'indeterminate', reason: 'ledger_state_unknown' });
    process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  } else if (error instanceof RuntimeSchemaError || error instanceof CapabilityEvidenceGroundingError) {
    process.stderr.write(refusalOutcome('refused', refusalMessage, error.issues));
  } else if (error instanceof CapabilityEvidenceCliError) {
    process.stderr.write(refusalOutcome('refused', refusalMessage, [error.issue]));
  } else {
    process.stderr.write(refusalOutcome('refused', 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED', [{ code: 'internal_error', path: [] }]));
  }
  process.exitCode = 1;
}
