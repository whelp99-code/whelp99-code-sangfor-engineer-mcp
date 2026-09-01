import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLedger } from '../packages/sangfor-hci-client/src/index.js';
import { isOfficeCliAvailable } from '../packages/sangfor-office/src/index.js';
import {
  buildEvidencePackage,
  gapReportItemsToEvidenceItems,
  type EvidencePackageItem,
} from '../packages/sangfor-evidence/src/evidence-package.js';
import type { GapReportItem } from '../packages/sangfor-audit/src/index.js';

// buildEvidencePackage builds the .docx THROUGH officecli (create + batch) —
// there is no hand-rolled fallback — so its whole test suite is skipped
// (not failed) when officecli isn't installed on this host, matching the
// same convention as tests/office-cli-wrapper.test.ts.
const officeCliInstalled = isOfficeCliAvailable().available;

// A minimal valid 1x1 PNG, so "evidence file present" tests don't depend on
// any real screenshot fixture.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000155273c7a0000000049454e44ae426082',
  'hex',
);

describe('gapReportItemsToEvidenceItems (no officecli required)', () => {
  it('maps GapReportItem fields verbatim, renaming evidenceRefs to evidenceFiles', () => {
    const gapItems: GapReportItem[] = [
      {
        itemId: '01',
        topic: 'EPP 대시보드 확인',
        reqIds: ['REQ01'],
        requiredEvidence: ['dashboard.png'],
        status: 'met',
        observed: '에이전트 100% 온라인',
        evidenceRefs: ['/tmp/dashboard.png'],
        missingEvidence: [],
        verdict: 'O',
      },
      {
        itemId: '02',
        topic: '미확인 항목',
        reqIds: ['REQ02'],
        requiredEvidence: ['x'],
        status: 'unknown',
        missingEvidence: ['x'],
        verdict: '미확인',
      },
    ];

    const mapped = gapReportItemsToEvidenceItems(gapItems);

    expect(mapped).toEqual([
      { itemId: '01', topic: 'EPP 대시보드 확인', reqIds: ['REQ01'], status: 'met', verdict: 'O', observed: '에이전트 100% 온라인', evidenceFiles: ['/tmp/dashboard.png'] },
      { itemId: '02', topic: '미확인 항목', reqIds: ['REQ02'], status: 'unknown', verdict: '미확인' },
    ]);
  });
});

describe.skipIf(!officeCliInstalled)('buildEvidencePackage (skipped: officecli not installed on this host)', () => {
  let root: string;
  let ledgerDir: string;
  let imagePath: string;
  let items: EvidencePackageItem[];
  const runId = 'evidence_pkg_test_run';

  const observedTextWithImage = '에이전트 100% 온라인, 격리 이벤트 0건 — 실측 그대로';
  const observedTextGap = '보존기간 3개월 확인, 요구 1년 미달';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sangfor-evidence-root-'));
    ledgerDir = mkdtempSync(join(tmpdir(), 'sangfor-evidence-ledger-'));
    process.env.SANGFOR_EVIDENCE_ROOT = root;

    imagePath = join(root, 'REQ01_evidence.png');
    writeFileSync(imagePath, TINY_PNG);

    // Built here (not as a describe-body top-level const) — the describe
    // callback body runs at suite COLLECTION time, before this beforeAll,
    // so a top-level const referencing imagePath would have captured it as
    // still-undefined.
    items = [
      { itemId: '01', topic: 'EPP 대시보드 확인', reqIds: ['REQ01'], status: 'met', verdict: 'O', observed: observedTextWithImage, evidenceFiles: [imagePath] },
      { itemId: '02', topic: '로그 보존 기간', reqIds: ['REQ02'], status: 'gap', verdict: 'X', observed: observedTextGap, evidenceFiles: ['/tmp/sangfor-evidence-does-not-exist.png'] },
      { itemId: '03', topic: '알 수 없는 항목', reqIds: [], status: 'unknown', verdict: '미확인' },
    ];
  });

  afterAll(() => {
    delete process.env.SANGFOR_EVIDENCE_ROOT;
    rmSync(root, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  function documentXml(docxPath: string): string {
    return execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' });
  }

  it('builds a schema-valid docx with correct counts, honest missing-evidence markers, and unaltered input text', async () => {
    const result = await buildEvidencePackage({
      title: 'ITAC 보안 필수사항 점검 증적 패키지',
      customer: 'ITAC',
      dateStamp: '20260806',
      items,
    });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.itemCount).toBe(3);
    expect(result.verdictCounts).toEqual({ O: 1, X: 1, 미확인: 1 });
    expect(result.imagesEmbedded).toBe(1);
    expect(result.imagesMissing).toBe(1);

    // officecli validate must pass — this is the whole point of building
    // through officecli instead of hand-rolled OpenXML.
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errorCount).toBe(0);

    const xml = documentXml(result.outputPath);
    // Item '03' claimed no evidence at all → plain marker, nothing to list.
    expect(xml).toContain('증적 파일 없음');
    // P3 (cross-review fix): item '02' claimed a file that doesn't exist —
    // "all evidence missing" must still name what was expected, not just
    // fall back to the generic marker (that used to be LESS informative
    // than the partial-missing case, which already listed names).
    expect(xml).toContain('증적 파일 없음: sangfor-evidence-does-not-exist.png');
    // observed/verdict text is carried through verbatim, not summarized or
    // reworded.
    expect(xml).toContain(observedTextWithImage);
    expect(xml).toContain(observedTextGap);
    expect(xml).toContain('ITAC 보안 필수사항 점검 증적 패키지');
  });

  it('reports an honest "no ledger entries" note (not a false allMatch:true) when captureRunId has no ledger data', async () => {
    const ledger = new AuditLedger({ dir: ledgerDir , authority: testLocalWriteAuthority('audit', ledgerDir)});
    const result = await buildEvidencePackage(
      // A path relative to the confined root, not an absolute join(root, ..)
      // reconstruction — root itself may be mkdtemp's pre-realpath form
      // (macOS /var vs /private/var), which confineOfficePath would then
      // (correctly) treat as outside its own realpath'd root.
      { title: 'No Ledger Test', customer: 'ITAC', dateStamp: '20260806', items: items.slice(0, 1), captureRunId: 'nonexistent_run', outputPath: 'no-ledger.docx' },
      { ledger },
    );
    expect(result.integrity).toBeDefined();
    expect(result.integrity!.files).toEqual([]);
    expect(result.integrity!.note).toMatch(/항목을 찾을 수 없음/);
  });

  it('reports per-file hash match/mismatch and chain integrity from a real (fake) capture ledger', async () => {
    const ledger = new AuditLedger({ dir: ledgerDir , authority: testLocalWriteAuthority('audit', ledgerDir)});
    const capturedAt = new Date().toISOString();
    const sha256 = createHash('sha256').update(TINY_PNG).digest('hex');
    await ledger.append(runId, 'response', { filePath: imagePath, sha256, capturedAt, ok: true });
    await ledger.append(runId, 'response', { filePath: join(root, 'tampered.png'), sha256: 'not-the-real-hash', capturedAt, ok: true });
    // The second recorded file doesn't need to exist on disk — its
    // currentHash simply comes back null and match:false, same as
    // console-evidence-capture's own tamper-detection semantics.

    const result = await buildEvidencePackage(
      { title: 'Ledger Test', customer: 'ITAC', dateStamp: '20260806', items: items.slice(0, 1), captureRunId: runId, outputPath: 'with-ledger.docx' },
      { ledger },
    );

    expect(result.integrity).toBeDefined();
    expect(result.integrity!.chainOk).toBe(true);
    expect(result.integrity!.allMatch).toBe(false);
    expect(result.integrity!.files).toHaveLength(2);
    expect(result.integrity!.files.find((f) => f.filePath === imagePath)?.match).toBe(true);
    expect(result.integrity!.files.find((f) => f.filePath.endsWith('tampered.png'))?.match).toBe(false);

    const xml = documentXml(result.outputPath);
    expect(xml).toContain('증적 무결성');
  });

  it('defaults outputPath to <evidence root>/packages/<dateStamp>/ when omitted', async () => {
    const result = await buildEvidencePackage({
      title: 'Default Path Test', customer: 'ITAC', dateStamp: '20260807', items: items.slice(2),
    });
    expect(result.outputPath).toContain(join('packages', '20260807'));
    expect(existsSync(result.outputPath)).toBe(true);
  });

  // P2 (cross-review fix): a second run against the same outputPath used to
  // silently blank a customer-facing package. Default is now refuse; the
  // caller must opt in with overwrite:true.
  it('refuses to overwrite an existing package by default, then succeeds with overwrite:true', async () => {
    const input = { title: 'Overwrite Test', customer: 'ITAC', dateStamp: '20260806', items: items.slice(2), outputPath: 'overwrite-test.docx' };
    const first = await buildEvidencePackage(input);
    expect(first.validation.valid).toBe(true);

    await expect(buildEvidencePackage(input)).rejects.toThrow(/OFFICE_FILE_EXISTS/);

    const second = await buildEvidencePackage({ ...input, overwrite: true });
    expect(second.validation.valid).toBe(true);
    expect(second.outputPath).toBe(first.outputPath);
  });
}, 30_000);
