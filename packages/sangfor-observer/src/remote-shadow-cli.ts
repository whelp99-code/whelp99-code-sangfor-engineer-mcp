import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import {
  compareRemoteShadow,
  parseRemoteShadowObservation,
  RemoteShadowInputError,
} from './remote-shadow.js';

export type RemoteShadowCliIo = {
  readonly readText: (path: string) => Promise<string>;
  readonly write: (line: string) => void;
};

const HELP = `Usage: remote-shadow-compare --local <observation.json> --remote <observation.json> --now <ISO-8601> --max-age-ms <integer>

Strictly compares required local and remote read-only facts. Exit 0 prints REMOTE_SHADOW_PASS;
input defects or any mismatch print REMOTE_SHADOW_MISMATCH and exit 2.`;

export async function runRemoteShadowCli(
  args: readonly string[],
  io: RemoteShadowCliIo = { readText: (path) => readFile(path, 'utf8'), write: (line) => process.stdout.write(`${line}\n`) },
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    io.write(HELP);
    return 0;
  }
  try {
    const options = parseArguments(args);
    const [localText, remoteText] = await Promise.all([io.readText(options.local), io.readText(options.remote)]);
    const localValue: unknown = JSON.parse(localText);
    const remoteValue: unknown = JSON.parse(remoteText);
    const report = compareRemoteShadow({
      local: parseRemoteShadowObservation(localValue),
      remote: parseRemoteShadowObservation(remoteValue),
      now: new Date(options.now),
      maxAgeMs: options.maxAgeMs,
    });
    io.write(report.code);
    io.write(JSON.stringify(report));
    return report.promotionEligible ? 0 : 2;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RemoteShadowInputError || error instanceof RemoteShadowCliError) {
      io.write('REMOTE_SHADOW_MISMATCH');
      io.write(JSON.stringify({ code: 'REMOTE_SHADOW_MISMATCH', promotionEligible: false, error: 'INPUT_REFUSED' }));
      return 2;
    }
    throw error;
  }
}

type CliOptions = {
  readonly local: string;
  readonly remote: string;
  readonly now: string;
  readonly maxAgeMs: number;
};

class RemoteShadowCliError extends Error {
  override readonly name = 'RemoteShadowCliError';
  constructor() { super('REMOTE_SHADOW_CLI_INVALID'); }
}

function parseArguments(args: readonly string[]): CliOptions {
  if (args.length !== 8) throw new RemoteShadowCliError();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || values.has(flag)) throw new RemoteShadowCliError();
    values.set(flag, value);
  }
  if ([...values.keys()].some((flag) => !['--local', '--remote', '--now', '--max-age-ms'].includes(flag))) {
    throw new RemoteShadowCliError();
  }
  const local = values.get('--local');
  const remote = values.get('--remote');
  const now = values.get('--now');
  const maxAgeText = values.get('--max-age-ms');
  if (!local || !remote || !now || !maxAgeText || !/^\d+$/u.test(maxAgeText)) throw new RemoteShadowCliError();
  const maxAgeMs = Number(maxAgeText);
  if (!Number.isSafeInteger(maxAgeMs)) throw new RemoteShadowCliError();
  return { local, remote, now, maxAgeMs };
}
