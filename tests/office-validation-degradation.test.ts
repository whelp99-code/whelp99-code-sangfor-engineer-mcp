import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Document validation must never be mistakable for a pass.
 *
 * `validateOfficeDocument` is best-effort by design: a customer host without
 * officecli still gets its document, only without the extra OpenXML schema
 * check. That degradation is correct — reporting it as an untyped `null` with
 * a prose note is not. Two very different situations collapse into the same
 * shape today:
 *
 *   1. officecli is absent           -> nothing was validated
 *   2. a DIFFERENT binary named `officecli` is on PATH (this really happened:
 *      the npm package `officecli` is an unrelated AI document-generation TUI)
 *      -> the `--version` probe SUCCEEDS, so the wrapper believes validation is
 *      available, then `validate --json` returns prose and the result quietly
 *      degrades while the note still claims the tool is merely "unavailable".
 *
 * A caller that wants to refuse shipping an unvalidated customer document
 * cannot branch on a prose sentence. Every non-validated outcome must carry a
 * stable machine-readable `code`, and an incompatible binary must not be
 * reported with the same code as an absent one.
 */

const REPO_OFFICE = '../packages/sangfor-office/src/index.js';

let bin: string;
let dir: string;
const savedBin = process.env.SANGFOR_OFFICECLI_BIN;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'office-degradation-'));
  vi.resetModules();
});

afterEach(() => {
  if (savedBin === undefined) delete process.env.SANGFOR_OFFICECLI_BIN;
  else process.env.SANGFOR_OFFICECLI_BIN = savedBin;
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** A stand-in binary that answers --version but cannot validate — the real collision. */
function writeIncompatibleBinary(): string {
  bin = join(dir, 'officecli-lookalike');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "officecli version 0.2.121"; exit 0; fi',
      'echo "officecli TUI requires a TTY. For scripts, use \\`officecli new ...\\`"',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('validateOfficeDocument — a degraded result is never mistakable for a pass', () => {
  it('reports an ABSENT officecli with a machine-readable code, not just prose', async () => {
    process.env.SANGFOR_OFFICECLI_BIN = join(dir, 'definitely-not-installed');
    const mod = await import(REPO_OFFICE);

    const result = await mod.validateOfficeDocument(join(dir, 'whatever.docx'));

    expect(result.valid, 'nothing was validated, so it must not claim true').toBe(null);
    expect(result.code, 'a caller must be able to branch without parsing prose').toBe('OFFICECLI_UNAVAILABLE');
  });

  it('distinguishes an INCOMPATIBLE binary from an absent one', async () => {
    // The npm `officecli` name collision: --version succeeds, validate cannot.
    process.env.SANGFOR_OFFICECLI_BIN = writeIncompatibleBinary();
    const mod = await import(REPO_OFFICE);

    const result = await mod.validateOfficeDocument(join(dir, 'whatever.docx'));

    expect(result.valid, 'an incompatible tool validated nothing').toBe(null);
    expect(
      result.code,
      'an installed-but-wrong tool must not look identical to a missing one',
    ).toBe('OFFICECLI_INCOMPATIBLE');
    expect(result.code).not.toBe('OFFICECLI_UNAVAILABLE');
  });

  it('exposes a single predicate callers use to refuse an unvalidated document', async () => {
    process.env.SANGFOR_OFFICECLI_BIN = join(dir, 'definitely-not-installed');
    const mod = await import(REPO_OFFICE);

    const degraded = await mod.validateOfficeDocument(join(dir, 'whatever.docx'));

    expect(mod.isDocumentSchemaValidated(degraded), 'null is not validated').toBe(false);
    expect(mod.isDocumentSchemaValidated({ valid: true, errorCount: 0, errors: [] })).toBe(true);
    expect(mod.isDocumentSchemaValidated({ valid: false, errorCount: 2, errors: ['a', 'b'] })).toBe(false);
  });
});
