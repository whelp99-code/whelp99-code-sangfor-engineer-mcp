import { readFileSync, writeFileSync } from 'node:fs';
import { diagnoseIagLiveObservation, type IagLiveDiagnosis } from './iag-live-observation.js';

type CliArgs = { input: string; output: string };

export function parseIagDiagnoseLiveArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  const tokens = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ((token !== '--input' && token !== '--output') || Object.prototype.hasOwnProperty.call(args, token.slice(2))) {
      throw new Error(`INPUT: unsupported or duplicate argument ${token}.`);
    }
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error(`INPUT: ${token} requires a value.`);
    args[token.slice(2) as keyof CliArgs] = value;
    i += 1;
  }
  if (!args.input || !args.output) throw new Error('INPUT: --input and --output are required.');
  return args as CliArgs;
}

export function diagnoseIagLiveInputText(inputText: string): IagLiveDiagnosis {
  let parsed: unknown;
  try { parsed = JSON.parse(inputText); } catch { throw new Error('INPUT: --input must contain valid JSON.'); }
  return diagnoseIagLiveObservation(parsed);
}

/** The only write in this bridge: save the requested advisory report. */
export function writeIagLiveDiagnosisOutput(outputPath: string, report: string): void {
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('INPUT: --output is required.');
  writeFileSync(outputPath, report, { encoding: 'utf8', flag: 'w' });
}

export async function runIagDiagnoseLiveCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { input, output } = parseIagDiagnoseLiveArgs(argv);
    let inputText: string;
    try { inputText = readFileSync(input, 'utf8'); } catch { throw new Error(`INPUT: cannot read --input ${input}.`); }
    const diagnosis = diagnoseIagLiveInputText(inputText);
    writeIagLiveDiagnosisOutput(output, diagnosis.report);
    process.stdout.write(`${JSON.stringify({ output, summary: diagnosis.result.summary }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIagDiagnoseLiveCli().then((code) => { process.exitCode = code; });
}
