import { readFileSync } from 'node:fs';
import { JOURNAL_REFUSALS, RefusalJournalError } from './journal-storage.js';
import {
  entryHash,
  headerHash,
  parseJournalEntry,
  parseJournalHeader,
  type JournalHeader,
  type RefusalJournalEntry,
} from './refusal-journal-schema.js';

/** Parses and verifies the complete persisted hash chain. */
export function readJournalEntries(
  path: string,
  expected: JournalHeader,
): readonly RefusalJournalEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.UNREADABLE);
  }
  const lines = text.split('\n').filter((value) => value.trim().length > 0);
  const headerLine = lines[0];
  if (lines.length === 0 || headerLine === undefined) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.EMPTY);
  }
  const header = parseJournalHeader(headerLine);
  if (!sameJournal(header, expected)) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.GENESIS_MISMATCH);
  }

  const entries: RefusalJournalEntry[] = [];
  let previousHash = headerHash(header);
  let sequence = 1;
  for (const line of lines.slice(1)) {
    const entry = parseJournalEntry(line);
    if (entry.sequence !== sequence || entry.previousHash !== previousHash) {
      throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
    }
    const { hash, ...unhashed } = entry;
    if (entryHash(unhashed) !== hash) {
      throw new RefusalJournalError(JOURNAL_REFUSALS.CORRUPT);
    }
    entries.push(entry);
    previousHash = entry.hash;
    sequence += 1;
  }
  return entries;
}

function sameJournal(actual: JournalHeader, expected: JournalHeader): boolean {
  return actual.genesisDigest === expected.genesisDigest
    && actual.journalEpoch === expected.journalEpoch
    && actual.tenantId === expected.tenantId
    && actual.projectId === expected.projectId
    && actual.installationId === expected.installationId
    && actual.deviceBindingDigest === expected.deviceBindingDigest;
}
