#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { FileSingleUseNonceStore } from '@sangfor/approval';
import { ZodError } from 'zod';
import {
  MAX_CAPABILITY_EVIDENCE_BYTES,
  CapabilityEvidenceGroundingError,
  FilePromotionLedger,
  PromotionLedgerUnavailableError,
  buildRepoCoverageContext,
  capabilityPromotionCliOutput,
  fetchBridgeToolRegistry,
  loadWorkAtomCatalog,
  parseGroundedCapabilityEvidence,
  executeCapabilityPromotion,
  nodeEvidenceFilesystem,
  parseEvidenceValidationContext,
  validateCapabilityEvidence,
  type CapabilityEvidenceGroundingIssue,
  type EvidenceValidationIssue,
} from '@sangfor/competency';
import {
  RuntimeSchemaError,
  type RuntimeSchemaIssue,
} from '../packages/shared/src/runtime-schema.js';

type CapabilityEvidenceCliIssue = RuntimeSchemaIssue | CapabilityEvidenceGroundingIssue | EvidenceValidationIssue | {
  readonly code:
    | 'invalid_arguments' | 'manifest_unreadable' | 'manifest_too_large'
    | 'validation_context_unavailable' | 'validation_context_invalid' | 'validation_context_too_large'
    | 'promotion_unreadable' | 'promotion_store_unavailable'
    | 'grounding_unavailable' | 'internal_error';
  readonly path: readonly (string | number)[];
};

class CapabilityEvidenceCliError extends Error {
  readonly name = 'CapabilityEvidenceCliError';

  constructor(readonly issue: CapabilityEvidenceCliIssue) {
    super(`CAPABILITY_EVIDENCE_CLI_ERROR: ${issue.code}`);
  }
}

function outcome(
  status: 'refused' | 'stale',
  message: 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED' | 'CAPABILITY_EVIDENCE_REFUSED' | 'CAPABILITY_EVIDENCE_STALE' | 'CAPABILITY_PROMOTION_REFUSED',
  violations: readonly CapabilityEvidenceCliIssue[],
): string {
  return `${JSON.stringify({ status, message, violations })}\n`;
}

function readBoundedFile(path: string, unreadableCode: 'manifest_unreadable' | 'validation_context_unavailable' | 'promotion_unreadable'): string {
  const tooLargeCode = unreadableCode === 'validation_context_unavailable' ? 'validation_context_too_large' : 'manifest_too_large';
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new CapabilityEvidenceCliError({ code: unreadableCode, path: [] });
    if (file.size > MAX_CAPABILITY_EVIDENCE_BYTES) throw new CapabilityEvidenceCliError({ code: tooLargeCode, path: [] });
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > MAX_CAPABILITY_EVIDENCE_BYTES) throw new CapabilityEvidenceCliError({ code: tooLargeCode, path: [] });
    return source;
  } catch (error) {
    if (error instanceof CapabilityEvidenceCliError) throw error;
    if (error instanceof Error) throw new CapabilityEvidenceCliError({ code: unreadableCode, path: [] });
    throw error;
  }
}

async function main(): Promise<void> {
  const [command, flag, manifestPath, nextFlag, nextValue, evidenceFlag, evidenceRoot, ...extra] = process.argv.slice(2);
  const parseCommand = command === 'parse' && nextFlag === undefined && nextValue === undefined;
  const verifyCommand = command === 'verify' && nextFlag === '--evidence-root' && nextValue !== undefined && nextValue !== '';
  const promoteCommand = command === 'promote' && nextFlag === '--promotion' && nextValue !== undefined && nextValue !== ''
    && evidenceFlag === '--evidence-root' && evidenceRoot !== undefined && evidenceRoot !== '';
  if ((!parseCommand && !verifyCommand && !promoteCommand) || flag !== '--manifest' || manifestPath === undefined || manifestPath === '' || extra.length > 0) {
    throw new CapabilityEvidenceCliError({ code: 'invalid_arguments', path: [] });
  }
  const source = readBoundedFile(manifestPath, 'manifest_unreadable');
  const registry = await fetchBridgeToolRegistry();
  if (!registry.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const coverage = buildRepoCoverageContext(registry.toolNames);
  if (!coverage.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const catalog = loadWorkAtomCatalog(coverage.context.catalogRoot);
  if (!catalog.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const manifest = parseGroundedCapabilityEvidence({ source, grounding: { atoms: catalog.atoms, context: coverage.context } });
  if (parseCommand) {
    process.stdout.write('CAPABILITY_EVIDENCE_SCHEMA_PASS\n');
    return;
  }
  const contextPath = process.env['SANGFOR_CAPABILITY_EVIDENCE_CONTEXT'];
  if (contextPath === undefined || contextPath === '') {
    throw new CapabilityEvidenceCliError({ code: 'validation_context_unavailable', path: [] });
  }
  let rawContext: unknown;
  try {
    rawContext = JSON.parse(readBoundedFile(contextPath, 'validation_context_unavailable'));
  } catch (error) {
    if (error instanceof CapabilityEvidenceCliError) throw error;
    if (error instanceof SyntaxError) throw new CapabilityEvidenceCliError({ code: 'validation_context_invalid', path: [] });
    throw error;
  }
  let validationContext;
  try {
    validationContext = parseEvidenceValidationContext(rawContext);
  } catch (error) {
    if (error instanceof ZodError) throw new CapabilityEvidenceCliError({ code: 'validation_context_invalid', path: [] });
    throw error;
  }
  if (promoteCommand) {
    const approvalSecret = process.env['SANGFOR_CAPABILITY_PROMOTION_SECRET'];
    const ledgerSecret = process.env['SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET'];
    const checkpointSecret = process.env['SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET'];
    const ledgerPath = process.env['SANGFOR_CAPABILITY_PROMOTION_LEDGER_PATH'];
    const noncePath = process.env['SANGFOR_CAPABILITY_PROMOTION_NONCE_STORE_PATH'];
    if (ledgerPath === undefined || ledgerPath === '' || ledgerSecret === undefined || checkpointSecret === undefined
      || approvalSecret === ledgerSecret || approvalSecret === checkpointSecret) {
      throw new CapabilityEvidenceCliError({ code: 'promotion_store_unavailable', path: [] });
    }
    const ledger = FilePromotionLedger.open(ledgerPath, ledgerSecret, checkpointSecret);
    const nonceFile = noncePath !== undefined && noncePath !== '' && existsSync(noncePath) ? lstatSync(noncePath) : undefined;
    const nonceStore = noncePath !== undefined && nonceFile?.isFile() === true && !nonceFile.isSymbolicLink()
      ? new FileSingleUseNonceStore(noncePath)
      : undefined;
    const result = await executeCapabilityPromotion({
      manifestSource: source,
      promotionSource: readBoundedFile(nextValue, 'promotion_unreadable'),
      grounding: { atoms: catalog.atoms, context: coverage.context },
      validation: { evidenceRoot, context: validationContext },
      secret: approvalSecret,
      nonceStore,
      ledger,
      now: validationContext.clock.now(),
    });
    const output = capabilityPromotionCliOutput(result);
    if (output.stdout.length > 0) process.stdout.write(output.stdout);
    if (output.stderr.length > 0) process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
    return;
  }
  const result = validateCapabilityEvidence({ manifest, evidenceRoot: nextValue, filesystem: nodeEvidenceFilesystem(), context: validationContext });
  switch (result.status) {
    case 'active':
      process.stdout.write('CAPABILITY_EVIDENCE_ACTIVE\n');
      return;
    case 'stale':
      process.stderr.write(outcome('stale', 'CAPABILITY_EVIDENCE_STALE', result.issues));
      process.exitCode = 1;
      return;
    case 'refused':
      process.stderr.write(outcome('refused', 'CAPABILITY_EVIDENCE_REFUSED', result.issues));
      process.exitCode = 1;
      return;
    default:
      result satisfies never;
  }
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch — top-level CLI boundary emits a redacted machine refusal.
  const refusalMessage = process.argv[2] === 'verify'
    ? 'CAPABILITY_EVIDENCE_REFUSED'
    : process.argv[2] === 'promote' ? 'CAPABILITY_PROMOTION_REFUSED' : 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED';
  if (error instanceof PromotionLedgerUnavailableError) {
    const output = capabilityPromotionCliOutput({ status: 'indeterminate', reason: 'ledger_state_unknown' });
    process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  } else if (error instanceof RuntimeSchemaError) {
    process.stderr.write(outcome('refused', refusalMessage, error.issues));
  } else if (error instanceof CapabilityEvidenceGroundingError) {
    process.stderr.write(outcome('refused', refusalMessage, error.issues));
  } else if (error instanceof CapabilityEvidenceCliError) {
    process.stderr.write(outcome('refused', refusalMessage, [error.issue]));
  } else {
    process.stderr.write(outcome('refused', 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED', [{ code: 'internal_error', path: [] }]));
  }
  process.exitCode = 1;
}
