import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOfficeDocument,
  confineOfficePath,
  createOfficeDocument,
  isOfficeCliAvailable,
  runOfficeBatch,
  validateOfficeDocument,
} from '../packages/sangfor-office/src/index.js';

// Whether officecli is actually installed on this host — assertions that
// depend on it running for real are skipped (not failed) when it isn't, per
// the "officecli 없는 CI에서도 스위트가 그린이어야 한다" requirement. Path
// confinement itself needs no officecli call, so those tests always run.
const officeCliAvailability = isOfficeCliAvailable();
const officeCliInstalled = officeCliAvailability.available;

describe('@sangfor/office — path confinement (no officecli required)', () => {
  let root: string;
  let outsideDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sangfor-office-root-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'sangfor-office-outside-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('accepts a relative path under the root and creates intermediate directories', () => {
    const resolved = confineOfficePath('nested/dir/file.docx', root);
    // Compare against the REAL root (mkdtemp's return can be a pre-realpath
    // form on macOS, e.g. /var vs /private/var) — see the identical note in
    // tests/console-evidence-capture.test.ts.
    const realRoot = realpathSync(root);
    expect(resolved).toBe(join(realRoot, 'nested', 'dir', 'file.docx'));
    expect(existsSync(join(root, 'nested', 'dir'))).toBe(true);
  });

  it('rejects a ".." escape', () => {
    expect(() => confineOfficePath('../escape.docx', root)).toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => confineOfficePath(join(outsideDir, 'file.docx'), root)).toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
  });

  it('rejects a pre-existing symlink whose target escapes the root', () => {
    const linkPath = join(root, 'escape-link');
    symlinkSync(outsideDir, linkPath);
    try {
      expect(() => confineOfficePath('escape-link/file.docx', root)).toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  it('rejects targeting the root directory itself as a file', () => {
    expect(() => confineOfficePath('.', root)).toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
  });

  it('createOfficeDocument/runOfficeBatch propagate the same confinement throw', async () => {
    await expect(createOfficeDocument('../escape2.docx', 'docx', { root })).rejects.toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
    await expect(runOfficeBatch('../escape3.docx', [], { root })).rejects.toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
  });

  // P1 (cross-review fix): closeOfficeDocument used to pass the caller's
  // path straight to `officecli close`, unconfined — close flushes to disk,
  // so this was a real write-outside-root gap unlike the read-only
  // validateOfficeDocument. Now confined the same way as create/batch.
  it('closeOfficeDocument rejects a path outside the confined root', async () => {
    await expect(closeOfficeDocument('../escape4.docx', { root })).rejects.toThrow(/OFFICE_PATH_OUTSIDE_ROOT/);
  });
});

describe('@sangfor/office — officecli availability fallback', () => {
  it('isOfficeCliAvailable reports a boolean + version/detail shape', () => {
    expect(typeof officeCliAvailability.available).toBe('boolean');
    if (officeCliAvailability.available) {
      expect(typeof officeCliAvailability.version).toBe('string');
    } else {
      expect(typeof officeCliAvailability.detail).toBe('string');
    }
  });

  it('validateOfficeDocument degrades to valid:null (never throws) when officecli cannot run', async () => {
    // Simulated via SANGFOR_OFFICECLI_BIN pointing at a path that cannot
    // exist. The module's OFFICECLI_BIN is a top-level const read once at
    // import time, so vi.resetModules() + a fresh dynamic import is needed
    // for the override to take effect (same PATH-manipulation idea the task
    // calls for, applied via the more targeted SANGFOR_OFFICECLI_BIN knob
    // instead of mutating the whole worker process's PATH).
    const saved = process.env.SANGFOR_OFFICECLI_BIN;
    process.env.SANGFOR_OFFICECLI_BIN = join(tmpdir(), `sangfor-office-does-not-exist-${Date.now()}`);
    vi.resetModules();
    try {
      const mod = await import('../packages/sangfor-office/src/index.js');
      const availability = mod.isOfficeCliAvailable();
      expect(availability.available).toBe(false);
      expect(typeof availability.detail).toBe('string');

      // validateOfficeDocument checks availability BEFORE touching the
      // filesystem, so a nonexistent path is fine here — the fallback fires
      // without ever calling officecli.
      const result = await mod.validateOfficeDocument('/tmp/does-not-matter.docx');
      expect(result).toEqual({ valid: null, errorCount: 0, errors: [], note: 'officecli unavailable' });
    } finally {
      if (saved === undefined) delete process.env.SANGFOR_OFFICECLI_BIN;
      else process.env.SANGFOR_OFFICECLI_BIN = saved;
      vi.resetModules();
    }
  });
});

describe.skipIf(!officeCliInstalled)('@sangfor/office — officecli-backed operations (skipped: officecli not installed on this host)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sangfor-office-live-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('createOfficeDocument + runOfficeBatch + validateOfficeDocument round-trip cleanly', async () => {
    const created = await createOfficeDocument('roundtrip.docx', 'docx', { root, overwrite: true });
    expect(created.ok).toBe(true);

    const batch = await runOfficeBatch(
      'roundtrip.docx',
      [{ command: 'add', parent: '/body', type: 'paragraph', props: { text: 'hello from batch' } }],
      { root },
    );
    expect(batch.ok).toBe(true);

    const validated = await validateOfficeDocument(join(root, 'roundtrip.docx'));
    expect(validated.valid).toBe(true);
    expect(validated.errorCount).toBe(0);
  });

  it('runOfficeBatch reports ok:false (not a throw) for an officecli-level command failure', async () => {
    await createOfficeDocument('failure.docx', 'docx', { root, overwrite: true });
    const batch = await runOfficeBatch(
      'failure.docx',
      [{ command: 'add', parent: '/nonexistent[99]', type: 'paragraph', props: { text: 'x' } }],
      { root },
    );
    expect(batch.ok).toBe(false);
    expect(typeof batch.error).toBe('string');
  });

  // P2 (cross-review fix): createOfficeDocument used to default to --force,
  // silently blanking an existing customer-facing document on a second run.
  it('createOfficeDocument refuses an existing target by default, then succeeds with overwrite:true', async () => {
    const first = await createOfficeDocument('existing.docx', 'docx', { root, overwrite: true });
    expect(first.ok).toBe(true);
    // createOfficeDocument leaves a resident open on the file; the
    // existsSync-based reject below never touches officecli so the resident
    // is irrelevant there, but the final overwrite:true create DOES call
    // `officecli create --force` again — which officecli itself refuses
    // while a resident still holds the file ("currently opened by a
    // resident process"). Close it first, matching the real
    // create -> batch -> close lifecycle buildEvidencePackage follows.
    await closeOfficeDocument('existing.docx', { root });

    const rejected = await createOfficeDocument('existing.docx', 'docx', { root });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/^OFFICE_FILE_EXISTS: .*\(pass overwrite:true to replace\)$/);

    const replaced = await createOfficeDocument('existing.docx', 'docx', { root, overwrite: true });
    expect(replaced.ok).toBe(true);
  });
});
