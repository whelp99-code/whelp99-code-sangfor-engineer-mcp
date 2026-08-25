#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import process from 'node:process';
import {
  MAX_CAPABILITY_EVIDENCE_BYTES,
  CapabilityEvidenceGroundingError,
  buildRepoCoverageContext,
  fetchBridgeToolRegistry,
  loadWorkAtomCatalog,
  parseGroundedCapabilityEvidence,
  type CapabilityEvidenceGroundingIssue,
} from '@sangfor/competency';
import {
  RuntimeSchemaError,
  type RuntimeSchemaIssue,
} from '../packages/shared/src/runtime-schema.js';

type CapabilityEvidenceCliIssue = RuntimeSchemaIssue | CapabilityEvidenceGroundingIssue | {
  readonly code:
    | 'invalid_arguments' | 'manifest_unreadable' | 'manifest_too_large'
    | 'grounding_unavailable' | 'internal_error';
  readonly path: readonly (string | number)[];
};

class CapabilityEvidenceCliError extends Error {
  readonly name = 'CapabilityEvidenceCliError';

  constructor(readonly issue: CapabilityEvidenceCliIssue) {
    super(`CAPABILITY_EVIDENCE_CLI_ERROR: ${issue.code}`);
  }
}

function refusal(violations: readonly CapabilityEvidenceCliIssue[]): string {
  return `${JSON.stringify({
    status: 'refused',
    message: 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED',
    violations,
  })}\n`;
}

async function main(): Promise<void> {
  const [command, flag, manifestPath, ...extra] = process.argv.slice(2);
  if (command !== 'parse' || flag !== '--manifest' || manifestPath === undefined || manifestPath === '' || extra.length > 0) {
    throw new CapabilityEvidenceCliError({ code: 'invalid_arguments', path: [] });
  }
  let source: string;
  try {
    const file = lstatSync(manifestPath);
    if (!file.isFile()) throw new CapabilityEvidenceCliError({ code: 'manifest_unreadable', path: [] });
    if (file.size > MAX_CAPABILITY_EVIDENCE_BYTES) {
      throw new CapabilityEvidenceCliError({ code: 'manifest_too_large', path: [] });
    }
    source = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (error instanceof CapabilityEvidenceCliError) throw error;
    if (error instanceof Error) throw new CapabilityEvidenceCliError({ code: 'manifest_unreadable', path: [] });
    throw error;
  }
  if (Buffer.byteLength(source) > MAX_CAPABILITY_EVIDENCE_BYTES) {
    throw new CapabilityEvidenceCliError({ code: 'manifest_too_large', path: [] });
  }
  const registry = await fetchBridgeToolRegistry();
  if (!registry.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const context = buildRepoCoverageContext(registry.toolNames);
  if (!context.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  const catalog = loadWorkAtomCatalog(context.context.catalogRoot);
  if (!catalog.ok) throw new CapabilityEvidenceCliError({ code: 'grounding_unavailable', path: [] });
  parseGroundedCapabilityEvidence({ source, grounding: { atoms: catalog.atoms, context: context.context } });
  process.stdout.write('CAPABILITY_EVIDENCE_SCHEMA_PASS\n');
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch — top-level CLI boundary emits a redacted machine refusal.
  if (error instanceof RuntimeSchemaError) {
    process.stderr.write(refusal(error.issues));
  } else if (error instanceof CapabilityEvidenceGroundingError) {
    process.stderr.write(refusal(error.issues));
  } else if (error instanceof CapabilityEvidenceCliError) {
    process.stderr.write(refusal([error.issue]));
  } else {
    process.stderr.write(refusal([{ code: 'internal_error', path: [] }]));
  }
  process.exitCode = 1;
}
