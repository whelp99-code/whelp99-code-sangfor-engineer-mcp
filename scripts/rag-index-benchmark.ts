import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { parseBenchmarkCorpus, BenchmarkRefusal } from '../packages/sangfor-rag/src/benchmark-schema.js';
import { runExactBenchmark, type RuntimeMetadata } from '../packages/sangfor-rag/src/benchmark-runner.js';

const HELP = `Usage: pnpm exec tsx scripts/rag-index-benchmark.ts [options]

Options:
  --queries <path>             Versioned sanitized benchmark corpus
  --backends exact             Exact scope-first BM25 + hash-cosine oracle
  --growth-multiplier <n>      Positive integer corpus multiplier
  --json                       Emit the JSON report
  --help                       Show this help
`;

class CliUsageError extends Error {
  readonly name = 'CliUsageError';
  readonly code = 'CLI_USAGE_INVALID';
}

type CliOptions = {
  readonly queries: string;
  readonly growthMultiplier: number;
};

function parseCli(argv: readonly string[]): CliOptions | undefined {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        queries: { type: 'string' },
        backends: { type: 'string' },
        'growth-multiplier': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : 'invalid arguments');
  }
  if (parsed.values.help) return undefined;
  const queries = parsed.values.queries;
  if (typeof queries !== 'string' || parsed.values.backends !== 'exact' || parsed.values.json !== true) {
    throw new CliUsageError('--queries, --backends exact, and --json are required');
  }
  const growthMultiplier = Number(parsed.values['growth-multiplier'] ?? '1');
  if (!Number.isSafeInteger(growthMultiplier) || growthMultiplier < 1) {
    throw new CliUsageError('--growth-multiplier must be a positive integer');
  }
  return { queries, growthMultiplier };
}

function runtimeMetadata(): RuntimeMetadata {
  const processors = cpus();
  const first = processors[0];
  if (!first) throw new BenchmarkRefusal('RUNTIME_METADATA_MISSING', 'CPU metadata is unavailable');
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: first.model,
    cores: processors.length,
    memoryBytes: totalmem()
  };
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  if (!options) {
    process.stdout.write(HELP);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.queries, 'utf8'));
  } catch (error) {
    throw new BenchmarkRefusal('CORPUS_READ_FAILED', error instanceof Error ? error.message : 'unknown read error');
  }
  const corpus = parseBenchmarkCorpus(raw);
  const report = runExactBenchmark(corpus, options.growthMultiplier, runtimeMetadata());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) { // no-excuse-ok: catch -- CLI boundary maps every refusal to a nonzero exit.
  if (error instanceof BenchmarkRefusal || error instanceof CliUsageError) {
    process.stderr.write(`rag-index-benchmark: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof Error) {
    process.stderr.write(`rag-index-benchmark: INTERNAL_ERROR: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write('rag-index-benchmark: INTERNAL_ERROR: unknown failure\n');
    process.exitCode = 1;
  }
}
