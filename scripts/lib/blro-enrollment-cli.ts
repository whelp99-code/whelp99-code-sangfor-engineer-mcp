import { z } from 'zod';
import { parseContractVersion } from '../../packages/sangfor-browser-contracts/src/protocol-version.js';
import {
  ADMIN_SCHEMA_VERSION,
  assessIncident,
  assessInstallationIdentity,
  assessReadiness,
  assessRevocation,
  assessRollout,
  assessRotation,
  containEmergency,
} from './blro-enrollment-policy.js';

export const ADMIN_HELP = `Usage: blro-enrollment-admin <command> [options]
Commands: identity rotation revocation emergency rollout readiness reconcile incident
Global: --apply (refused unless an existing authority performs the write), --help
Output: one JSON object; dry-run/read-only by default.
`;

const commandSchema = z.enum([
  'identity', 'rotation', 'revocation', 'emergency', 'rollout', 'readiness', 'reconcile', 'incident',
]);
const optionSchema = z.enum([
  'installation-id', 'identity-count', 'overlap-seconds', 'observation-age-seconds', 'incident-id',
  'blro-version', 'jm-version', 'blro-ready', 'writes-contained', 'job-id', 'dispatch-state',
  'mutation-attempted', 'read-back', 'ca-compromised', 'apply',
]);
const sensitiveOption = /(?:private|secret|token|capability|cookie|passphrase|key)(?:-|$)/iu;
const valueOptions = new Set([
  'installation-id', 'identity-count', 'overlap-seconds', 'observation-age-seconds', 'incident-id',
  'blro-version', 'jm-version', 'job-id', 'dispatch-state', 'read-back',
]);

type ParsedArgs = {
  readonly command: z.infer<typeof commandSchema>;
  readonly options: Readonly<Record<string, string | boolean>>;
};

export class AdminCliInputError extends Error {
  override readonly name = 'AdminCliInputError';
  constructor(readonly reason: 'BAD_INPUT' | 'SECRET_ARGUMENT_REFUSED') {
    super(reason);
  }
}

export function parseAdminArgs(argv: readonly string[]): ParsedArgs | { readonly help: true } {
  const input = argv[0] === '--' ? argv.slice(1) : argv;
  if (input.length === 1 && input[0] === '--help') return { help: true };
  const commandResult = commandSchema.safeParse(input[0]);
  if (!commandResult.success) throw new AdminCliInputError('BAD_INPUT');
  const options: Record<string, string | boolean> = {};
  for (let index = 1; index < input.length; index += 1) {
    const argument = input[index];
    if (!argument?.startsWith('--')) throw new AdminCliInputError('BAD_INPUT');
    const name = argument.slice(2);
    if (sensitiveOption.test(name)) throw new AdminCliInputError('SECRET_ARGUMENT_REFUSED');
    const parsedName = optionSchema.safeParse(name);
    if (!parsedName.success || options[name] !== undefined) throw new AdminCliInputError('BAD_INPUT');
    if (valueOptions.has(name)) {
      const value = input[index + 1];
      if (!value || value.startsWith('--')) throw new AdminCliInputError('BAD_INPUT');
      options[name] = value;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { command: commandResult.data, options };
}

const requiredString = (options: ParsedArgs['options'], name: string): string => {
  const value = options[name];
  if (typeof value !== 'string') throw new AdminCliInputError('BAD_INPUT');
  return z.string().trim().min(1).max(200).parse(value);
};
const integer = (options: ParsedArgs['options'], name: string): number => {
  const value = requiredString(options, name);
  const parsed = z.coerce.number().int().nonnegative().safeParse(value);
  if (!parsed.success) throw new AdminCliInputError('BAD_INPUT');
  return parsed.data;
};
const flag = (options: ParsedArgs['options'], name: string): boolean => options[name] === true;
const version = (options: ParsedArgs['options'], name: string) => {
  const parsed = parseContractVersion(requiredString(options, name));
  if (!parsed) throw new AdminCliInputError('BAD_INPUT');
  return parsed;
};

export function executeAdminCommand(parsed: ParsedArgs): Readonly<Record<string, unknown>> {
  const { options } = parsed;
  switch (parsed.command) {
    case 'identity':
      return assessInstallationIdentity({
        installationId: requiredString(options, 'installation-id'),
        identityCount: integer(options, 'identity-count'), apply: flag(options, 'apply'),
      });
    case 'rotation':
      return assessRotation({
        installationId: requiredString(options, 'installation-id'),
        identityCount: integer(options, 'identity-count'),
        overlapSeconds: integer(options, 'overlap-seconds'), apply: flag(options, 'apply'),
      });
    case 'revocation':
      return assessRevocation({
        installationId: requiredString(options, 'installation-id'),
        observationAgeSeconds: integer(options, 'observation-age-seconds'), apply: flag(options, 'apply'),
      });
    case 'emergency':
      if (!flag(options, 'ca-compromised')) throw new AdminCliInputError('BAD_INPUT');
      return containEmergency(requiredString(options, 'incident-id'));
    case 'rollout':
      return assessRollout({
        blroVersion: version(options, 'blro-version'), jmVersion: version(options, 'jm-version'),
        blroReady: flag(options, 'blro-ready'),
      });
    case 'readiness':
      return assessReadiness({
        blroReady: flag(options, 'blro-ready'), writesContained: flag(options, 'writes-contained'),
      });
    case 'incident':
    case 'reconcile': {
      const dispatchState = z.enum(['PREDISPATCH', 'INDETERMINATE'])
        .parse(requiredString(options, 'dispatch-state'));
      const readBackValue = options['read-back'];
      const readBack = typeof readBackValue === 'string'
        ? z.enum(['PASS', 'FAIL', 'INDETERMINATE']).parse(readBackValue)
        : undefined;
      return assessIncident({
        operation: parsed.command, jobId: requiredString(options, 'job-id'), dispatchState,
        mutationAttempted: flag(options, 'mutation-attempted'), ...(readBack ? { readBack } : {}),
      });
    }
    default:
      return assertNever(parsed.command);
  }
}

export function cliError(reason: AdminCliInputError['reason']): Readonly<Record<string, unknown>> {
  return { schemaVersion: ADMIN_SCHEMA_VERSION, status: 'REFUSED', execution: 'NOT_RUN', reason };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled enrollment administration command: ${String(value)}`);
}
