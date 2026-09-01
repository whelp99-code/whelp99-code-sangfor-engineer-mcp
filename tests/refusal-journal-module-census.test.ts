import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  JournalHeader,
  JournalRefusal,
  JournalReservation,
  JournalReservationInput,
  OpenJournalInput,
  RefusalJournalEntry,
} from '../packages/sangfor-jm-agent/src/refusal-journal.js';

const SOURCE_ROOT = join(process.cwd(), 'packages/sangfor-jm-agent/src');

function pureLines(fileName: string): number {
  return readFileSync(join(SOURCE_ROOT, fileName), 'utf8').split('\n')
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('//'))
    .length;
}

const JOURNAL_MODULES = [
  'refusal-journal.ts',
  'refusal-journal-parser.ts',
  'refusal-journal-schema.ts',
  'refusal-journal-state.ts',
] as const;

describe('refusal journal module boundary', () => {
  it.each(JOURNAL_MODULES)('keeps %s below the source-size ceiling', (fileName) => {
    // Given one security-coherent refusal journal module
    // When its executable source lines are counted
    const count = pureLines(fileName);

    // Then the module fits within one reviewable responsibility
    expect(count).toBeLessThanOrEqual(250);
  });

  it('preserves the public type export surface', () => {
    // Given every established public type is imported from the facade
    type PublicTypeCensus = readonly [
      JournalHeader,
      JournalRefusal,
      JournalReservation,
      JournalReservationInput,
      OpenJournalInput,
      RefusalJournalEntry,
    ];

    // When TypeScript evaluates the census, then no export has disappeared
    expectTypeOf<PublicTypeCensus>().toEqualTypeOf<PublicTypeCensus>();
  });

  it('preserves the public runtime export surface', async () => {
    // Given the public refusal journal module
    // When its runtime exports are enumerated
    const journalModule = await import('../packages/sangfor-jm-agent/src/refusal-journal.js');

    // Then callers retain the exact established API
    expect(Object.keys(journalModule).sort()).toEqual([
      'JOURNAL_HEADER_KIND',
      'JOURNAL_REFUSALS',
      'REFUSAL_JOURNAL_VERSION',
      'RefusalJournal',
      'RefusalJournalError',
      'appendDurably',
      'assertSecureFile',
      'assertSecureRoot',
      'createJournalExclusively',
      'journalHeaderLine',
    ]);
  });
});
