import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  JOURNAL_FILE_NAME,
  JOURNAL_HEADER_KIND,
  appendDurably,
  createJournalExclusively,
  journalHeaderLine,
} from '../../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_PROJECT_ID,
  JM_TENANT_ID,
} from './jm-agent-identity.js';

/**
 * TESTS ONLY. Establishes a journal exactly as the operator CLI would: 0700
 * root, 0600 file, canonical signed-grant-bound header, durable append. It is
 * never imported by the app or the package.
 */
export function initialiseTestJournal(root: string, header: {
  readonly journalEpoch: number;
  readonly genesisDigest: string;
}): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, JOURNAL_FILE_NAME);
  createJournalExclusively(path);
  appendDurably(path, journalHeaderLine({
    kind: JOURNAL_HEADER_KIND,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    deviceBindingDigest: JM_DEVICE_DIGEST,
    journalEpoch: header.journalEpoch,
    genesisDigest: header.genesisDigest,
  }));
  return path;
}
