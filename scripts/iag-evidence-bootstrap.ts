#!/usr/bin/env node
import process from 'node:process';
import {
  IAG_EVIDENCE_BOOTSTRAP_USAGE,
  IagEvidenceBootstrapInputError,
  parseIagEvidenceBootstrapArgs,
  readIagEvidenceBootstrapApproval,
} from './lib/iag-evidence-bootstrap-input.js';
import {
  runIagEvidenceBootstrap,
  type IagEvidenceBootstrapRunCommand,
} from './lib/iag-evidence-bootstrap-runner.js';

/**
 * Authority preflight for the O1 IAG evidence bootstrap.
 *
 * This entrypoint injects no execution seam, so it can only ever report a
 * refusal: an action that clears every authority gate stops at
 * `IAG_BOOTSTRAP_EXECUTION_SEAM_REQUIRED` rather than being executed. Composing
 * a browser, session, or device seam is a separate, explicitly injected step.
 */
async function preflight(command: IagEvidenceBootstrapRunCommand): Promise<void> {
  const outcome = await runIagEvidenceBootstrap({
    command,
    approval: command.approvalPath === undefined
      ? undefined
      : readIagEvidenceBootstrapApproval(command.approvalPath),
  });
  switch (outcome.kind) {
    case 'REFUSED':
      process.stderr.write(`${outcome.code}\n`);
      process.exitCode = 1;
      return;
    case 'HANDED_TO_EXECUTION':
      throw new TypeError('IAG_BOOTSTRAP_ENTRYPOINT_COMPOSES_NO_EXECUTION_SEAM');
    default:
      throw new TypeError(`Unhandled bootstrap outcome: ${JSON.stringify(outcome)}`);
  }
}

async function main(): Promise<void> {
  const command = parseIagEvidenceBootstrapArgs(process.argv.slice(2));
  switch (command.kind) {
    case 'help':
      process.stdout.write(`${IAG_EVIDENCE_BOOTSTRAP_USAGE}\n`);
      return;
    case 'run':
      await preflight(command);
      return;
    default:
      throw new TypeError(`Unhandled bootstrap command: ${JSON.stringify(command)}`);
  }
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch - top-level CLI boundary emits one stable redacted refusal code.
  process.stderr.write(`${
    error instanceof IagEvidenceBootstrapInputError ? error.code : 'IAG_BOOTSTRAP_ENTRYPOINT_FAILED'
  }\n`);
  process.exitCode = 1;
}
