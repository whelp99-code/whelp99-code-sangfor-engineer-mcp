import {
  JM_AGENT_ENVIRONMENT_NAMES,
  JM_AGENT_FORBIDDEN_FIELDS,
  type JmAgentEnvironment,
} from '../../../packages/sangfor-jm-agent/src/index.js';
import { JmAgentStartupError } from './composition.js';
import { exitCodeFor, installSignalHandlers, startJmAgentProcess } from './process.js';

const HELP = [
  'sangfor-jm-browser-agent — JM-side browser execution agent (mTLS, loopback only)',
  '',
  'Usage: tsx apps/jm-browser-agent/src/index.ts [--help]',
  '',
  'Routes:',
  '  GET  /live            process-only liveness; never calls a dependency',
  '  GET  /ready           dependency-aware readiness (trust, receipt, verifier, drain)',
  '  POST /v1/browser-jobs strict signed job route; refuses before the executor',
  '',
  'Required environment:',
  ...JM_AGENT_ENVIRONMENT_NAMES.map((name) => `  ${name}`),
  '',
  'Refused if present (no mock execution exists in production):',
  ...JM_AGENT_FORBIDDEN_FIELDS.map((name) => `  ${name}`),
  '',
  'JM never receives BLRO database credentials and is never the authority.',
  'Every dispatch requires a per-request signed blro-authority-receipt.v1.',
].join('\n');

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  try {
    const agent = await startJmAgentProcess(process.env as JmAgentEnvironment);
    const signals = installSignalHandlers(agent);
    console.log(
      `Sangfor JM browser agent listening on https://${agent.composition.config.bindHost}:${String(agent.port)}`,
    );
    // Stay alive until the single memoized drain settles, then exit on its
    // outcome: 0 for a graceful close, nonzero when work was left outstanding.
    const outcome = await signals.settled;
    // Release the handlers only once the drain has settled AND we are about to
    // return, so no signal in between can trigger Node's default termination.
    signals.dispose();
    console.log(`Sangfor JM browser agent drained: ${outcome.kind}`);
    return exitCodeFor(outcome);
  } catch (error) {
    process.stderr.write(`${startupMessage(error)}\n`);
    return 1;
  }
}

function startupMessage(error: unknown): string {
  if (error instanceof JmAgentStartupError) return error.message;
  return error instanceof Error ? error.message : 'JM browser agent failed to start.';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
