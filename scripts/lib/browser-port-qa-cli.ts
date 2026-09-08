/**
 * Argument surface of `scripts/test-browser-port.ts`: the scenario tokens, the
 * default mock-console base URL, and the machine-readable `--help` payload.
 */
import process from 'node:process';

const HELP_SENTINEL = 'JM_BROWSER_PORT_QA_HELP';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3400/hci';
const HELP_OPTIONS = ['--help', '--scenario', '--base-url'] as const;
const REFUSAL_SCENARIOS = ['bad-origin', 'forbidden-operation'] as const;
const LOCAL_READBACK_SCENARIO = 'local-readback';

export type RefusalScenario = (typeof REFUSAL_SCENARIOS)[number];

export type BrowserPortQaCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'refusal'; readonly scenario: RefusalScenario; readonly baseUrl: string }
  | { readonly kind: 'local-readback'; readonly baseUrl: string };

export class BrowserPortQaArgumentError extends Error {
  readonly name = 'BrowserPortQaArgumentError';
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args.at(index + 1) : undefined;
}

/**
 * The base URL is deliberately left unparsed: an unusable value must keep
 * surfacing as the `URL` failure raised inside the scenario that uses it.
 */
export function parseBrowserPortQaCommand(args: readonly string[]): BrowserPortQaCommand {
  if (args.includes('--help')) return { kind: 'help' };
  const scenario = optionValue(args, '--scenario');
  if (scenario === undefined) throw new BrowserPortQaArgumentError('Missing --scenario.');
  const baseUrl = optionValue(args, '--base-url') ?? DEFAULT_BASE_URL;
  const refusal = REFUSAL_SCENARIOS.find((candidate) => candidate === scenario);
  if (refusal !== undefined) return { kind: 'refusal', scenario: refusal, baseUrl };
  if (scenario !== LOCAL_READBACK_SCENARIO) {
    throw new BrowserPortQaArgumentError(`Unknown scenario: ${scenario}`);
  }
  return { kind: 'local-readback', baseUrl };
}

export function printBrowserPortQaHelp(): void {
  process.stdout.write(`${JSON.stringify({
    sentinel: HELP_SENTINEL,
    options: HELP_OPTIONS,
    scenarios: [...REFUSAL_SCENARIOS, LOCAL_READBACK_SCENARIO],
    defaultBaseUrl: DEFAULT_BASE_URL,
  })}\n`);
}
