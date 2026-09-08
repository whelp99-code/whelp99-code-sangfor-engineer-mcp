import process from 'node:process';

const HELP_OPTIONS = {
  global: ['--help'],
  parse: ['--help', '--manifest'],
  verify: ['--help', '--manifest', '--evidence-root'],
  promote: ['--help', '--manifest', '--promotion', '--evidence-root'],
  stale: ['--help', '--manifest', '--validation-context', '--evidence-root', '--promotion-ledger'],
  census: ['--help', '--json'],
  campaign: ['--help', 'scaffold', '--product', '--output'],
} as const;

type HelpCommand = keyof typeof HELP_OPTIONS;

export function parseHelpCommand(args: readonly string[]): HelpCommand | undefined {
  if (args.length === 1 && args[0] === '--help') return 'global';
  if (args.length === 2 && args[1] === '--help') {
    const command = args[0];
    if (command === 'parse' || command === 'verify' || command === 'promote' || command === 'stale'
      || command === 'census' || command === 'campaign') return command;
  }
  if (args.length === 3 && args[0] === 'campaign' && args[1] === 'scaffold' && args[2] === '--help') return 'campaign';
  return undefined;
}

export function printHelp(command: HelpCommand): void {
  process.stdout.write(`${JSON.stringify({
    sentinel: 'CAPABILITY_EVIDENCE_HELP',
    command,
    options: HELP_OPTIONS[command],
  })}\n`);
}
