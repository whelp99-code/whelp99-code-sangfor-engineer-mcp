import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger } from '../packages/sangfor-hci-client/src/index.js';
import type {
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  captureConsoleEvidence, verifyCaptureLedger, resolveConfinedOutputDir,
} from '../packages/sangfor-screenshot/src/console-evidence.js';

// Card B3: verify the capture engine without any real browser by injecting the
// JSON BrowserExecutionPort and local artifact materializer.
// Every AuditLedger used here points at a scratch tmp dir; never the real
// data/evidence root. outputDir is now confined (S1) to SANGFOR_EVIDENCE_ROOT
// (or the real repo data/evidence root if unset), so every test that writes
// captures points SANGFOR_EVIDENCE_ROOT at a scratch tmp dir too and only
// ever passes RELATIVE outputDir values into the engine — never an absolute
// path we constructed ourselves, which on macOS could textually disagree
// with the root's realpath (/tmp vs /private/tmp) and produce a false
// "outside root" rejection that has nothing to do with the security check
// under test.

let evidenceRoot: string;
let ledgerDir: string;
const savedEvidenceRootEnv = process.env.SANGFOR_EVIDENCE_ROOT;

beforeEach(() => {
  evidenceRoot = mkdtempSync(join(tmpdir(), 'console-evidence-root-'));
  ledgerDir = mkdtempSync(join(tmpdir(), 'console-evidence-ledger-'));
  process.env.SANGFOR_EVIDENCE_ROOT = evidenceRoot;
});

afterEach(() => {
  if (savedEvidenceRootEnv === undefined) delete process.env.SANGFOR_EVIDENCE_ROOT;
  else process.env.SANGFOR_EVIDENCE_ROOT = savedEvidenceRootEnv;
  rmSync(evidenceRoot, { recursive: true, force: true });
  rmSync(ledgerDir, { recursive: true, force: true });
});

function makeFakePort(
  opts: { failNavigateUrl?: string } = {},
): BrowserExecutionPort & { requests: BrowserExecutionRequest[] } {
  const requests: BrowserExecutionRequest[] = [];
  return {
    requests,
    async execute(request): Promise<BrowserExecutionResult> {
      requests.push(request);
      if (
        request.operation.kind === 'perform_console_action'
        && request.operation.action.type === 'navigate'
        && request.operation.action.target === opts.failNavigateUrl
      ) {
        return {
          schemaVersion: 'browser-execution-result.v1',
          requestId: request.requestId,
          status: 'FAIL',
          mutationAttempted: false,
          evidence: [],
          error: {
            code: 'SIMULATED_NAVIGATION_FAILURE',
            message: `simulated navigation failure: ${opts.failNavigateUrl}`,
          },
        };
      }
      return {
        schemaVersion: 'browser-execution-result.v1',
        requestId: request.requestId,
        status: 'PASS',
        mutationAttempted: false,
        readBack: { status: 'PASS' },
        evidence: request.operation.kind === 'capture_console_evidence'
          ? [{
              artifactRef: `artifact://test/${request.requestId}`,
              sha256: 'a'.repeat(64),
              mediaType: 'image/png',
              size: 8,
            }]
          : [],
      };
    },
  };
}

function portDeps(port: BrowserExecutionPort, ledger: AuditLedger) {
  return {
    ledger,
    executionPort: port,
    sessionId: 'console-evidence-test',
    origin: 'https://console.example',
    materializeArtifact: async (_artifactRef: string, destinationPath: string) => {
      writeFileSync(destinationPath, Buffer.from(`fake-png-bytes:${destinationPath}`));
    },
  };
}

describe('captureConsoleEvidence — browser port injection (no real browser)', () => {
  it('captures 3 items via an injected port: filenames, sha256, capturedAt, chainOk', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      {
        product: 'ENDPOINT_SECURE',
        dateStamp: '20260804',
        outputDir: 'out',
        captures: [
          { reqId: '01', menuLabel: 'Dashboard', menuPath: [{ menu: 'Dashboard' }] },
          { reqId: '02', menuLabel: 'Policy > Malware', menuPath: [{ menu: 'Policy', submenu: 'Malware/Ransomware Protection' }] },
          { reqId: '03', menuLabel: 'Snapshot', url: 'https://console.example/dashboard' },
        ],
      },
      portDeps(port, ledger),
    );

    expect(result.runId).toMatch(/^console_capture_/);
    expect(result.captures).toHaveLength(3);
    expect(result.chainOk).toBe(true);

    const [a, b, c] = result.captures;
    expect(a.ok).toBe(true);
    expect(a.filePath).toBe(join(result.outputDir, 'REQ01_ENDPOINT_SECURE_Dashboard_Before_20260804.png'));
    expect(b.filePath).toBe(join(result.outputDir, 'REQ02_ENDPOINT_SECURE_Policy_Malware_Before_20260804.png'));
    expect(c.filePath).toBe(join(result.outputDir, 'REQ03_ENDPOINT_SECURE_Snapshot_Before_20260804.png'));

    for (const item of result.captures) {
      expect(existsSync(item.filePath)).toBe(true);
      const expectedHash = createHash('sha256').update(readFileSync(item.filePath)).digest('hex');
      expect(item.sha256).toBe(expectedHash);
      expect(item.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The ledger hash-chain independently proves nothing changed since capture.
    expect(ledger.verify(result.runId).ok).toBe(true);
    const lines = readFileSync(result.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l: any) => l.payload.reqId)).toEqual(['01', '02', '03']);
  });

  it('masks embedded secrets before filenames and ledger persistence', async () => {
    const ledger = new AuditLedger({ dir: ledgerDir });
    const result = await captureConsoleEvidence({
      product: 'IAG',
      dateStamp: '20260804',
      outputDir: 'out',
      captures: [{
        reqId: 'token=abc',
        menuLabel: 'password=xy',
      }],
    }, portDeps(makeFakePort(), ledger));

    const persisted = readFileSync(result.ledgerPath, 'utf8');
    expect(persisted).not.toContain('abc');
    expect(persisted).not.toContain('xy');
    expect(result.captures[0]?.filePath).not.toMatch(/abc|xy/);
  });

  it('normalizes filename segments and blocks path traversal from untrusted reqId/menuLabel', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      {
        product: 'IAG',
        dateStamp: '20260804',
        outputDir: 'out',
        captures: [
          { reqId: '../../etc/passwd', menuLabel: 'weird label/with spaces & slashes!' },
        ],
      },
      portDeps(port, ledger),
    );

    expect(result.captures).toHaveLength(1);
    const [item] = result.captures;
    expect(item.ok).toBe(true);

    // Must land directly inside outputDir (no subdirectory escape), with a
    // filename built only from the allowed charset.
    const rel = relative(result.outputDir, item.filePath);
    expect(rel).toBe(basename(item.filePath));
    expect(rel.includes('..')).toBe(false);
    expect(basename(item.filePath)).toMatch(/^[A-Za-z0-9._-]+\.png$/);
    expect(existsSync(item.filePath)).toBe(true);
  });

  it('a failing capture item is recorded ok:false and does not stop the remaining items', async () => {
    const port = makeFakePort({ failNavigateUrl: 'https://bad.example/fail' });
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      {
        product: 'CYBER_COMMAND',
        dateStamp: '20260804',
        outputDir: 'out',
        captures: [
          { reqId: '01', menuLabel: 'Ok One', menuPath: [{ menu: 'Dashboard' }] },
          { reqId: '02', menuLabel: 'Broken', url: 'https://bad.example/fail' },
          { reqId: '03', menuLabel: 'Ok Two', menuPath: [{ menu: 'Alerts' }] },
        ],
      },
      portDeps(port, ledger),
    );

    expect(result.captures).toHaveLength(3);
    expect(result.captures[0].ok).toBe(true);
    expect(result.captures[1].ok).toBe(false);
    expect(result.captures[1].error).toMatch(/simulated navigation failure/);
    expect(result.captures[1].sha256).toBeNull();
    expect(result.captures[2].ok).toBe(true);

    // The ledger still records all three attempts, including the failure.
    const lines = readFileSync(result.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[1].payload.ok).toBe(false);
    expect(result.chainOk).toBe(true);
  });

  it('missing BrowserExecutionPort throws a clear composition error', async () => {
    const ledger = new AuditLedger({ dir: ledgerDir });

    await expect(
      captureConsoleEvidence(
        { product: 'HCI_SCP', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'x' }] },
        { ledger },
      ),
    ).rejects.toThrow(/BROWSER_EXECUTION_PORT_REQUIRED/);
  });
});

describe('S1 — outputDir confinement (security)', () => {
  it('allows a normal nested relative subpath under the evidence root', () => {
    const resolved = resolveConfinedOutputDir('captures/20260804');
    expect(existsSync(resolved)).toBe(true);
    // Compare against the REAL evidenceRoot, not the mkdtemp()-returned form —
    // on macOS os.tmpdir() paths go through a /tmp -> /private/tmp symlink,
    // so a textual comparison against the pre-realpath form would produce a
    // false "outside root" here that has nothing to do with the confinement
    // logic under test.
    const realEvidenceRoot = realpathSync(evidenceRoot);
    expect(relative(realEvidenceRoot, resolved).startsWith('..')).toBe(false);
  });

  it('rejects an absolute path outside the evidence root', () => {
    const outsideAbs = join(tmpdir(), 'definitely-outside-evidence-root');
    expect(() => resolveConfinedOutputDir(outsideAbs)).toThrow(/^CAPTURE_DIR_OUTSIDE_ROOT:/);
  });

  it("rejects a relative path that escapes the root via '..'", () => {
    expect(() => resolveConfinedOutputDir('../../etc/evil')).toThrow(/^CAPTURE_DIR_OUTSIDE_ROOT:/);
  });

  it('rejects a pre-existing symlink partway down the path, even though it lexically looks confined', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'console-evidence-outside-'));
    mkdirSync(join(evidenceRoot, 'captures'), { recursive: true });
    symlinkSync(outsideDir, join(evidenceRoot, 'captures', 'link'), 'dir');

    expect(() => resolveConfinedOutputDir('captures/link/out')).toThrow(/^CAPTURE_DIR_OUTSIDE_ROOT:/);

    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('captureConsoleEvidence rejects an out-of-root outputDir before calling the port', async () => {
    const ledger = new AuditLedger({ dir: ledgerDir });
    const port = makeFakePort();

    await expect(
      captureConsoleEvidence(
        { product: 'IAG', outputDir: join(tmpdir(), 'outside-root'), captures: [{ reqId: '01', menuLabel: 'x' }] },
        portDeps(port, ledger),
      ),
    ).rejects.toThrow(/^CAPTURE_DIR_OUTSIDE_ROOT:/);
    expect(port.requests).toEqual([]);
  });
});

describe('S2 — destructive-label denylist (security)', () => {
  it('refuses a capture item whose menuPath clicks a denylisted label, and does not screenshot it', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      {
        product: 'IAG',
        dateStamp: '20260804',
        outputDir: 'out',
        captures: [
          { reqId: '01', menuLabel: 'Safe Dashboard', menuPath: [{ menu: 'Dashboard' }] },
          { reqId: '02', menuLabel: 'Danger', menuPath: [{ menu: 'Policy', submenu: 'Delete' }] },
          { reqId: '03', menuLabel: 'Also Safe', menuPath: [{ menu: 'Alerts' }] },
        ],
      },
      portDeps(port, ledger),
    );

    expect(result.captures).toHaveLength(3);
    expect(result.captures[0].ok).toBe(true);
    expect(result.captures[1].ok).toBe(false);
    expect(result.captures[1].error).toBe('REFUSED_DESTRUCTIVE_MENU_LABEL: Delete');
    expect(result.captures[1].sha256).toBeNull();
    expect(result.captures[2].ok).toBe(true);

    // Nothing was screenshotted for the refused item.
    expect(port.requests.some((request) =>
      request.operation.kind === 'capture_console_evidence'
      && request.operation.captureId === '02')).toBe(false);
    expect(existsSync(result.captures[1].filePath)).toBe(false);
  });

  it('matches case-insensitively, as a substring, and in Korean', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      {
        product: 'IAG', dateStamp: '20260804', outputDir: 'out',
        captures: [
          { reqId: '01', menuLabel: 'x', menuPath: [{ menu: 'please DELETE this policy' }] },
          { reqId: '02', menuLabel: 'x', menuPath: [{ menu: '정책', submenu: '삭제' }] },
          { reqId: '03', menuLabel: 'x', menuPath: [{ menu: 'RESTART service' }] },
        ],
      },
      portDeps(port, ledger),
    );

    for (const item of result.captures) {
      expect(item.ok).toBe(false);
      expect(item.error).toMatch(/^REFUSED_DESTRUCTIVE_MENU_LABEL:/);
    }
  });

  it('also refuses based on menuLabel alone (defense in depth), even with no menuPath', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'IAG', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Confirm Removal Screen' }] },
      portDeps(port, ledger),
    );

    expect(result.captures[0].ok).toBe(false);
    expect(result.captures[0].error).toMatch(/^REFUSED_DESTRUCTIVE_MENU_LABEL:/);
  });

  it('does not refuse an ordinary safe label', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'IAG', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard Overview', menuPath: [{ menu: 'Dashboard' }] }] },
      portDeps(port, ledger),
    );

    expect(result.captures[0].ok).toBe(true);
  });
});

describe('verifyCaptureLedger — tamper detection (read-only, S3 single-read + S4 shape guard)', () => {
  it('reports chainOk + per-file match:true right after a clean capture', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'NDR', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard' }] },
      portDeps(port, ledger),
    );

    const verify = verifyCaptureLedger(result.runId, { ledger });
    expect(verify.chainOk).toBe(true);
    expect(verify.allMatch).toBe(true);
    expect(verify.files).toHaveLength(1);
    expect(verify.files[0]).toMatchObject({ filePath: result.captures[0].filePath, match: true });
    expect(verify.files[0].recordedHash).toBe(result.captures[0].sha256);
    expect(verify.files[0].currentHash).toBe(result.captures[0].sha256);
  });

  it('detects a modified screenshot file after capture (match:false)', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'NDR', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard' }] },
      portDeps(port, ledger),
    );

    // Tamper with the evidence file after the fact.
    writeFileSync(result.captures[0].filePath, Buffer.from('tampered-bytes'));

    const verify = verifyCaptureLedger(result.runId, { ledger });
    expect(verify.chainOk).toBe(true); // the ledger itself was not touched
    expect(verify.allMatch).toBe(false);
    expect(verify.files[0].match).toBe(false);
    expect(verify.files[0].recordedHash).not.toBe(verify.files[0].currentHash);
  });

  it('reports match:false, currentHash:null for a missing/deleted screenshot file', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'NDR', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard' }] },
      portDeps(port, ledger),
    );

    rmSync(result.captures[0].filePath);

    const verify = verifyCaptureLedger(result.runId, { ledger });
    expect(verify.allMatch).toBe(false);
    expect(verify.files[0].match).toBe(false);
    expect(verify.files[0].currentHash).toBeNull();
  });

  it('detects a broken hash chain (ledger line tampered directly)', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'NDR', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard' }] },
      portDeps(port, ledger),
    );

    const lines = readFileSync(result.ledgerPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.payload.sha256 = 'deadbeef'.repeat(8);
    writeFileSync(result.ledgerPath, `${JSON.stringify(tampered)}\n`);

    const verify = verifyCaptureLedger(result.runId, { ledger });
    expect(verify.chainOk).toBe(false);
    expect(verify.allMatch).toBe(false);
  });

  it('S4: a ledger line with an unexpected payload shape is reported, not silently skipped', async () => {
    const port = makeFakePort();
    const ledger = new AuditLedger({ dir: ledgerDir });

    const result = await captureConsoleEvidence(
      { product: 'NDR', dateStamp: '20260804', outputDir: 'out', captures: [{ reqId: '01', menuLabel: 'Dashboard' }] },
      portDeps(port, ledger),
    );

    // Append a well-formed ledger line (valid hash chain) but with a payload
    // shape this module never produces itself (no filePath/sha256).
    ledger.append(result.runId, 'response', { note: 'not a capture record' });

    const verify = verifyCaptureLedger(result.runId, { ledger });
    expect(verify.chainOk).toBe(true); // the chain math itself is still internally consistent
    expect(verify.files).toHaveLength(2);
    expect(verify.files[1]).toMatchObject({ filePath: '', recordedHash: null, currentHash: null, match: false, note: 'LEDGER_SHAPE_UNEXPECTED' });
    expect(verify.allMatch).toBe(false);
  });
});
