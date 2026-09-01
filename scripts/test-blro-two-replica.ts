import { fileURLToPath } from 'node:url';
import { createTwoReplicaFixture } from './lib/blro-two-replica-fixture.js';
import { runReplicaChild } from './lib/blro-two-replica-child.js';
import { ReplicaProcess } from './lib/blro-two-replica-runner.js';
import { runCoreScenarios } from './lib/blro-two-replica-scenarios.js';

const PASS_SENTINEL = 'BLRO_TWO_REPLICA_PASS';
const HELP = `Usage: test-blro-two-replica.ts --replicas 2 --attempts <positive integer> --jm-url https://127.0.0.1:39443/v1/browser-jobs`;

type CliOptions = {
  readonly replicas: 2;
  readonly attempts: number;
  readonly jmUrl: string;
};

async function main(): Promise<void> {
  if (process.argv.includes('--child')) {
    process.once('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('kind' in raw) || raw.kind !== 'config' || !('config' in raw)) {
        throw new CliError('CHILD_CONFIG_INVALID');
      }
      void runReplicaChild(raw.config).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        process.disconnect?.();
        process.exitCode = 1;
      });
    });
    return;
  }
  const options = parseCli(process.argv.slice(2));
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const ownerUrl = requiredEnvironment('BLRO_OWNER_DATABASE_URL');
  const fixture = await createTwoReplicaFixture({ databaseUrl, ownerUrl, jmUrl: options.jmUrl });
  const entrypoint = fileURLToPath(import.meta.url);
  const replicas = [
    new ReplicaProcess(fixture.configs[0], entrypoint),
    new ReplicaProcess(fixture.configs[1], entrypoint),
  ] as const;
  try {
    await Promise.all(replicas.map((replica) => replica.start()));
    await runCoreScenarios({ fixture, replicas, attempts: options.attempts });
    process.stdout.write(`${PASS_SENTINEL}\n`);
  } finally {
    await Promise.all(replicas.map((replica) => replica.stop()));
    await fixture.close();
  }
}

function parseCli(arguments_: readonly string[]): CliOptions {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new CliError('CLI_ARGUMENT_INVALID');
    values.set(key, value);
  }
  const replicas = Number(values.get('--replicas'));
  const attempts = Number(values.get('--attempts'));
  const jmUrlText = values.get('--jm-url');
  if (replicas !== 2) throw new CliError('REPLICAS_MUST_EQUAL_TWO');
  if (!Number.isSafeInteger(attempts) || attempts < 2) throw new CliError('ATTEMPTS_INVALID');
  if (!jmUrlText) throw new CliError('JM_URL_REQUIRED');
  const jmUrl = new URL(jmUrlText);
  if (jmUrl.protocol !== 'https:' || jmUrl.hostname !== '127.0.0.1' || jmUrl.port !== '39443'
    || jmUrl.pathname !== '/v1/browser-jobs' || jmUrl.search || jmUrl.hash || jmUrl.username || jmUrl.password) {
    throw new CliError('JM_URL_INVALID');
  }
  return { replicas: 2, attempts, jmUrl: jmUrl.href };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new CliError(`${name}_REQUIRED`);
  return value;
}

class CliError extends Error { override readonly name = 'CliError'; }

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}:${error.message}` : 'UNKNOWN'}\n`);
  process.exitCode = 1;
});
