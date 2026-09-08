import { z } from 'zod';
import {
  ADMIN_HELP,
  AdminCliInputError,
  cliError,
  executeAdminCommand,
  parseAdminArgs,
} from './lib/blro-enrollment-cli.js';

function main(): void {
  try {
    const parsed = parseAdminArgs(process.argv.slice(2));
    if ('help' in parsed) {
      process.stdout.write(ADMIN_HELP);
      return;
    }
    process.stdout.write(`${JSON.stringify(executeAdminCommand(parsed))}\n`);
  } catch (error) {
    if (error instanceof AdminCliInputError || error instanceof z.ZodError) {
      const reason = error instanceof AdminCliInputError ? error.reason : 'BAD_INPUT';
      process.stderr.write(`${JSON.stringify(cliError(reason))}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main();
