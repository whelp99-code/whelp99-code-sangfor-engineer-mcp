import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { O1_ACTION_KINDS } from '../../packages/sangfor-safety/src/index.js';
import type { WriteAuthorityReferences } from '../../packages/sangfor-competency/src/write-authority.js';
import { canonicalizeUrlOrigin } from '../../packages/shared/src/index.js';

export const IAG_EVIDENCE_BOOTSTRAP_INPUT_CODES = [
  'IAG_BOOTSTRAP_ARGUMENTS_INVALID',
  'IAG_BOOTSTRAP_APPROVAL_DOCUMENT_REFUSED',
] as const;

export type IagEvidenceBootstrapInputCode = typeof IAG_EVIDENCE_BOOTSTRAP_INPUT_CODES[number];

export class IagEvidenceBootstrapInputError extends Error {
  readonly name = 'IagEvidenceBootstrapInputError';

  constructor(readonly code: IagEvidenceBootstrapInputCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export const IAG_EVIDENCE_BOOTSTRAP_USAGE = [
  'Usage: tsx scripts/iag-evidence-bootstrap.ts --help',
  '       tsx scripts/iag-evidence-bootstrap.ts \\',
  '         --manifest <path> --validation-context <path> \\',
  '         --evidence-root <dir> --ledger <path> \\',
  '         --origin <https://iag-console.example> \\',
  `         --action-kind <${O1_ACTION_KINDS.join('|')}> \\`,
  '         [--approval <path>]',
  '',
  'Every identity in the O1 action (device, firmware, window, session, campaign) is',
  'derived from the referenced authority; the flags only name the origin and the',
  'exact action kind. Unknown flags, duplicated references, broadened action kinds,',
  `and bare positional arguments are refused with ${IAG_EVIDENCE_BOOTSTRAP_INPUT_CODES[0]}.`,
  '',
  'This entrypoint composes no browser, session, or device execution seam, so an',
  'action that clears every authority gate is refused rather than executed.',
].join('\n');

const FLAG_FIELDS = {
  '--manifest': 'manifestPath',
  '--validation-context': 'validationContextPath',
  '--evidence-root': 'evidenceRoot',
  '--ledger': 'ledgerPath',
  '--origin': 'originId',
  '--action-kind': 'actionKind',
  '--approval': 'approvalPath',
} as const;

type FlagName = keyof typeof FLAG_FIELDS;

const runArgumentsSchema = z.object({
  manifestPath: z.string().min(1),
  validationContextPath: z.string().min(1),
  evidenceRoot: z.string().min(1),
  ledgerPath: z.string().min(1),
  originId: z.string().min(1),
  actionKind: z.enum(O1_ACTION_KINDS),
  approvalPath: z.string().min(1).optional(),
}).strict();

export type IagEvidenceBootstrapCommand =
  | { readonly kind: 'help' }
  | {
    readonly kind: 'run';
    readonly references: WriteAuthorityReferences;
    readonly originId: string;
    readonly actionKind: typeof O1_ACTION_KINDS[number];
    readonly approvalPath?: string;
  };

function isFlagName(value: string): value is FlagName {
  return Object.hasOwn(FLAG_FIELDS, value);
}

function invalid(): IagEvidenceBootstrapInputError {
  return new IagEvidenceBootstrapInputError('IAG_BOOTSTRAP_ARGUMENTS_INVALID');
}

/**
 * Reads the argument vector as strict `--flag value` pairs. A value that is
 * itself flag-shaped is refused rather than consumed, so a forgotten value
 * cannot silently swallow either a known or future flag.
 */
function flagValues(args: readonly string[]): Map<FlagName, string> {
  const values = new Map<FlagName, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args.at(index);
    const value = args.at(index + 1);
    if (flag === undefined || !isFlagName(flag)) throw invalid();
    if (value === undefined || value.startsWith('--')) throw invalid();
    if (values.has(flag)) throw invalid();
    values.set(flag, value);
  }
  return values;
}

export function parseIagEvidenceBootstrapArgs(args: readonly string[]): IagEvidenceBootstrapCommand {
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' };
  const parsed = runArgumentsSchema.safeParse(Object.fromEntries(
    [...flagValues(args)].map(([flag, value]) => [FLAG_FIELDS[flag], value]),
  ));
  if (!parsed.success) throw invalid();
  const { manifestPath, validationContextPath, evidenceRoot, ledgerPath } = parsed.data;
  let originId: string;
  try {
    originId = canonicalizeUrlOrigin(parsed.data.originId, 'origin');
  } catch {
    throw invalid();
  }
  return {
    kind: 'run',
    references: { manifestPath, validationContextPath, evidenceRoot, ledgerPath },
    originId,
    actionKind: parsed.data.actionKind,
    ...(parsed.data.approvalPath === undefined ? {} : { approvalPath: parsed.data.approvalPath }),
  };
}

/**
 * Loads the approval document as untrusted JSON. The document crosses into the
 * typed world exactly once, inside the bootstrap authorization gate, so nothing
 * here interprets or repairs its fields.
 */
export function readIagEvidenceBootstrapApproval(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { // no-excuse-ok: catch - an unreadable approval document is a typed CLI refusal, never a default.
    throw new IagEvidenceBootstrapInputError('IAG_BOOTSTRAP_APPROVAL_DOCUMENT_REFUSED', { cause: error });
  }
}
