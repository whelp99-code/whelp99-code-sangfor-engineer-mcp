import process from 'node:process';
import { ZodError } from 'zod';
import {
  FilePromotionLedger,
  PromotionLedgerUnavailableError,
  buildRepoCoverageContext,
  fetchBridgeToolRegistry,
  loadWorkAtomCatalog,
  nodeEvidenceFilesystem,
  parseEvidenceValidationContext,
  parseGroundedCapabilityEvidence,
  validateAndPersistEvidenceStaleness,
} from '@sangfor/competency';
import { CapabilityEvidenceCliError, refusalOutcome } from './capability-evidence-cli-errors.js';
import { readBoundedFile } from './capability-evidence-cli-io.js';

export type StaleCliCommand = {
  readonly manifestPath: string;
  readonly validationContextPath: string;
  readonly evidenceRoot: string;
  readonly ledgerPath: string;
};

export function parseStaleCliCommand(args: readonly string[]): StaleCliCommand | undefined {
  if (args.length !== 9 || args[0] !== 'stale' || args[1] !== '--manifest'
    || args[3] !== '--validation-context' || args[5] !== '--evidence-root'
    || args[7] !== '--promotion-ledger') return undefined;
  const manifestPath = args[2];
  const validationContextPath = args[4];
  const evidenceRoot = args[6];
  const ledgerPath = args[8];
  if (manifestPath === undefined || manifestPath === '' || validationContextPath === undefined
    || validationContextPath === '' || evidenceRoot === undefined || evidenceRoot === ''
    || ledgerPath === undefined || ledgerPath === '') return undefined;
  return { manifestPath, validationContextPath, evidenceRoot, ledgerPath };
}

export async function runStaleCliCommand(command: StaleCliCommand): Promise<void> {
  const registry = await fetchBridgeToolRegistry();
  if (!registry.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const coverage = buildRepoCoverageContext(registry.toolNames);
  if (!coverage.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const catalog = loadWorkAtomCatalog(coverage.context.catalogRoot);
  if (!catalog.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const manifestSource = readBoundedFile(command.manifestPath, 'manifest_unreadable');
  const manifest = parseGroundedCapabilityEvidence({
    source: manifestSource,
    grounding: { atoms: catalog.atoms, context: coverage.context },
  });
  let validationContext;
  try {
    validationContext = parseEvidenceValidationContext(JSON.parse(
      readBoundedFile(command.validationContextPath, 'validation_context_unavailable'),
    ));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new CapabilityEvidenceCliError({ code: 'validation_context_invalid', path: [] });
    }
    throw error;
  }
  const baseline = coverage.context.maturityByCapability.get(
    `${manifest.target.productId}::${manifest.target.capabilityId}`,
  );
  if (baseline === undefined) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  let ledger: FilePromotionLedger;
  try {
    ledger = FilePromotionLedger.open(
      command.ledgerPath,
      process.env['SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET'],
      process.env['SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET'],
    );
  } catch (error) {
    if (error instanceof PromotionLedgerUnavailableError) {
      process.stderr.write('CAPABILITY_EVIDENCE_STALE_INDETERMINATE\n');
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const result = await validateAndPersistEvidenceStaleness({
    manifestSource,
    manifest,
    evidenceRoot: command.evidenceRoot,
    filesystem: nodeEvidenceFilesystem(),
    context: validationContext,
    baseline,
    ledger,
  });
  switch (result.status) {
    case 'no_change': process.stdout.write('CAPABILITY_EVIDENCE_NO_CHANGE\n'); return;
    case 'applied': process.stdout.write('CAPABILITY_EVIDENCE_STALE_PERSISTED\n'); return;
    case 'refused':
      process.stderr.write(refusalOutcome('refused', 'CAPABILITY_EVIDENCE_REFUSED', result.issues));
      process.exitCode = 1;
      return;
    case 'indeterminate': process.stderr.write('CAPABILITY_EVIDENCE_STALE_INDETERMINATE\n'); process.exitCode = 2; return;
    default: result satisfies never;
  }
}
