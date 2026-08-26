import { existsSync, lstatSync } from 'node:fs';
import process from 'node:process';
import { FileSingleUseNonceStore } from '@sangfor/approval';
import { ZodError } from 'zod';
import {
  FilePromotionLedger,
  buildRepoCoverageContext,
  capabilityPromotionCliOutput,
  executeCapabilityPromotion,
  fetchBridgeToolRegistry,
  loadWorkAtomCatalog,
  nodeEvidenceFilesystem,
  parseEvidenceValidationContext,
  parseGroundedCapabilityEvidence,
  validateCapabilityEvidence,
} from '@sangfor/competency';
import { CapabilityEvidenceCliError, refusalOutcome } from './capability-evidence-cli-errors.js';
import { readBoundedFile } from './capability-evidence-cli-io.js';

export type ExistingCommand =
  | { readonly kind: 'parse'; readonly manifestPath: string }
  | { readonly kind: 'verify'; readonly manifestPath: string; readonly evidenceRoot: string }
  | { readonly kind: 'promote'; readonly manifestPath: string; readonly promotionPath: string; readonly evidenceRoot: string };

export function parseExistingCommand(args: readonly string[]): ExistingCommand | undefined {
  const [command, flag, manifestPath, nextFlag, nextValue, evidenceFlag, evidenceRoot, ...extra] = args;
  if (flag !== '--manifest' || manifestPath === undefined || manifestPath === '' || extra.length > 0) return undefined;
  if (command === 'parse' && nextFlag === undefined && nextValue === undefined) return { kind: 'parse', manifestPath };
  if (command === 'verify' && nextFlag === '--evidence-root' && nextValue !== undefined && nextValue !== '') {
    return { kind: 'verify', manifestPath, evidenceRoot: nextValue };
  }
  if (command === 'promote' && nextFlag === '--promotion' && nextValue !== undefined && nextValue !== ''
    && evidenceFlag === '--evidence-root' && evidenceRoot !== undefined && evidenceRoot !== '') {
    return { kind: 'promote', manifestPath, promotionPath: nextValue, evidenceRoot };
  }
  return undefined;
}

async function loadGroundedManifest(command: ExistingCommand) {
  const source = readBoundedFile(command.manifestPath, 'manifest_unreadable');
  const registry = await fetchBridgeToolRegistry();
  if (!registry.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const coverage = buildRepoCoverageContext(registry.toolNames);
  if (!coverage.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const catalog = loadWorkAtomCatalog(coverage.context.catalogRoot);
  if (!catalog.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  return {
    source,
    manifest: parseGroundedCapabilityEvidence({ source, grounding: { atoms: catalog.atoms, context: coverage.context } }),
    catalog,
    coverage,
  };
}

function loadValidationContext() {
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
  try {
    return parseEvidenceValidationContext(rawContext);
  } catch (error) {
    if (error instanceof ZodError) throw new CapabilityEvidenceCliError({ code: 'validation_context_invalid', path: [] });
    throw error;
  }
}

export async function runExistingCommand(command: ExistingCommand): Promise<void> {
  const grounded = await loadGroundedManifest(command);
  if (command.kind === 'parse') {
    process.stdout.write('CAPABILITY_EVIDENCE_SCHEMA_PASS\n');
    return;
  }
  const validationContext = loadValidationContext();
  if (command.kind === 'promote') {
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
      manifestSource: grounded.source,
      promotionSource: readBoundedFile(command.promotionPath, 'promotion_unreadable'),
      grounding: { atoms: grounded.catalog.atoms, context: grounded.coverage.context },
      validation: { evidenceRoot: command.evidenceRoot, context: validationContext },
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
  const result = validateCapabilityEvidence({
    manifest: grounded.manifest,
    evidenceRoot: command.evidenceRoot,
    filesystem: nodeEvidenceFilesystem(),
    context: validationContext,
  });
  switch (result.status) {
    case 'active': process.stdout.write('CAPABILITY_EVIDENCE_ACTIVE\n'); return;
    case 'stale':
      process.stderr.write(refusalOutcome('stale', 'CAPABILITY_EVIDENCE_STALE', result.issues));
      process.exitCode = 1;
      return;
    case 'refused':
      process.stderr.write(refusalOutcome('refused', 'CAPABILITY_EVIDENCE_REFUSED', result.issues));
      process.exitCode = 1;
      return;
    default: result satisfies never;
  }
}
