import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  JOURNAL_FILE_NAME,
  JOURNAL_HEADER_KIND,
  appendDurably,
  createJournalExclusively,
  journalHeaderLine,
  verifyGrantSnapshot,
} from '../packages/sangfor-jm-agent/src/index.js';

/**
 * Operator-only initialiser for the JM refusal journal.
 *
 * The production service never creates a journal; this CLI is the single path
 * that may, and it demands a SIGNED grant snapshot plus an explicit --apply.
 * The header it writes is bound to that snapshot's epoch and genesis, and the
 * write is fsynced through appendDurably.
 */

class JournalInitError extends Error {
  override readonly name = 'JournalInitError';
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv: readonly string[]): number {
  const root = argument(argv, '--root');
  const snapshotPath = argument(argv, '--grant-snapshot');
  const publicKeyPath = argument(argv, '--verify-key');
  const tenantId = argument(argv, '--tenant');
  const projectId = argument(argv, '--project');
  const installationId = argument(argv, '--installation');
  if (!root || !snapshotPath || !publicKeyPath || !tenantId || !projectId || !installationId) {
    process.stderr.write(
      'usage: jm-journal-init --root <dir> --grant-snapshot <file> --verify-key <pem> '
      + '--tenant <id> --project <id> --installation <id> [--apply]\n',
    );
    return 2;
  }
  const decision = verifyGrantSnapshot({
    snapshot: readFileSync(snapshotPath, 'utf8'),
    publicKeyPem: readFileSync(publicKeyPath, 'utf8'),
    expected: { tenantId, projectId, installationId },
    now: new Date(),
  });
  if (!decision.ok) throw new JournalInitError(`GRANT_SNAPSHOT_REFUSED: ${decision.reason}`);
  const snapshot = decision.snapshot;
  const header = {
    kind: JOURNAL_HEADER_KIND,
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    installationId: snapshot.installationId,
    deviceBindingDigest: snapshot.deviceBindingDigest,
    journalEpoch: snapshot.authorityEpoch,
    genesisDigest: snapshot.journalGenesis,
  } as const;
  const path = join(root, JOURNAL_FILE_NAME);
  if (!argv.includes('--apply')) {
    process.stdout.write(`JM_JOURNAL_INIT_DRY_RUN ${path}\n`);
    return 0;
  }
  if (existsSync(path)) throw new JournalInitError(`JOURNAL_ALREADY_ESTABLISHED: ${path}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  // Exclusive create at 0600 so the header never exists at a wider mode and an
  // existing journal is never clobbered.
  createJournalExclusively(path);
  appendDurably(path, journalHeaderLine(header));
  process.stdout.write(`JM_JOURNAL_INIT_APPLIED ${path}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
