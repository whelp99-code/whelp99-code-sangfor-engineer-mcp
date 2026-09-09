import { createHash } from 'node:crypto';
import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsavedEngineerCase } from '../../../packages/sangfor-authority/src/engineer-case-persistence.js';
import type { EngineerCaseUnsaved } from '../../../packages/sangfor-authority/src/authority-store-contracts.js';
import { exportEngineerGuide } from '../../../packages/sangfor-product-adapters/src/engineer-guide-export.js';
import {
  parseEngineerCaseDocument,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
} from '../../../packages/shared/src/engineer-case-contract.js';
import {
  engineerCaseHttpStatus,
  readEngineerCaseId,
  type EngineerCaseApiPort,
} from './engineer-case-api.js';

export type EngineerGuideExportBody = {
  readonly caseId: string;
  readonly expectedRevision?: string;
};

export type EngineerGuideExportSuccess = {
  readonly ok: true;
  readonly status: 'exported';
  readonly downloadComplete: true;
  readonly caseId: string;
  readonly artifactId: string;
  readonly exportedCaseRevision: string;
  readonly exportedGuideRevision: string;
  readonly currentCaseRevision: string;
  readonly revisionChangedDuringExport: boolean;
  readonly approved: false;
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
  readonly fieldAccepted: false;
  readonly approvedForWindow: false;
  readonly recomputed: false;
};

export type EngineerGuideExportFailure = EngineerCaseUnsaved & {
  readonly downloadComplete: false;
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
  readonly exportedCaseRevision?: string;
  readonly exportedGuideRevision?: string;
  readonly currentCaseRevision?: string;
};

export type EngineerGuideDownloadFile = {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly mediaType: string;
};

const DOC_MEDIA = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILE_NAME_RE = /^[A-Za-z0-9._-]+\.docx$/u;

function grantsFalse() {
  return {
    approved: false as const,
    guideReadyGranted: false as const,
    executionPassGranted: false as const,
    fieldAccepted: false as const,
    approvedForWindow: false as const,
    recomputed: false as const,
  };
}

function exportUnsaved(
  code: EngineerCaseUnsaved['code'],
  extra: Partial<EngineerGuideExportFailure> = {},
  issues?: EngineerCaseUnsaved['issues'],
): EngineerGuideExportFailure {
  return {
    ...unsavedEngineerCase(code, issues),
    downloadComplete: false,
    guideReadyGranted: false,
    executionPassGranted: false,
    ...extra,
  };
}

function safeFileName(caseId: string, guideRevision: string): string {
  const candidate = `${caseId}-${guideRevision}.docx`;
  return FILE_NAME_RE.test(candidate) ? candidate : 'engineer-guide.docx';
}

function parseStoredDocx(payload: string): { bytes: Buffer; fileName: string } | undefined {
  try {
    const parsed = JSON.parse(payload) as { encoding?: unknown; bytes?: unknown; fileName?: unknown };
    if (parsed.encoding !== 'base64' || typeof parsed.bytes !== 'string' || typeof parsed.fileName !== 'string') {
      return undefined;
    }
    if (!FILE_NAME_RE.test(parsed.fileName)) return undefined;
    return { bytes: Buffer.from(parsed.bytes, 'base64'), fileName: parsed.fileName };
  } catch {
    return undefined;
  }
}

export async function postExportEngineerGuide(
  body: EngineerGuideExportBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
): Promise<{ readonly status: number; readonly body: EngineerGuideExportSuccess | EngineerGuideExportFailure }> {
  if (!auth) return { status: 401, body: exportUnsaved('SCOPE_UNAUTHORIZED') };
  const loaded = await store.load({ ...auth, caseId: body.caseId });
  if (!loaded.ok) {
    return { status: engineerCaseHttpStatus(loaded), body: exportUnsaved(loaded.code, {}, loaded.issues) };
  }
  let snapshot: EngineerCaseDocument;
  try {
    snapshot = parseEngineerCaseDocument(JSON.stringify(loaded.document));
  } catch {
    return { status: 400, body: exportUnsaved('VALIDATION_FAILED') };
  }

  const exportedCaseRevision = snapshot.revision;
  const exportedGuideRevision = snapshot.guide.revision;
  const outputRoot = mkdtempSync(join(tmpdir(), 'e10b-guide-'));
  const fileName = safeFileName(snapshot.caseId, exportedGuideRevision);
  try {
    const exported = await exportEngineerGuide({
      document: snapshot,
      auth,
      outputPath: fileName,
      outputRoot,
    });
    if (!exported.ok) {
      return {
        status: 400,
        body: exportUnsaved('VALIDATION_FAILED', {
          exportedCaseRevision,
          exportedGuideRevision,
          currentCaseRevision: exportedCaseRevision,
        }, [{ code: exported.code, path: 'guide' }]),
      };
    }

    const bytes = readFileSync(join(outputRoot, exported.docxPath.split(/[/\\]/u).pop() ?? fileName));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const artifactId = 'gdocx-1';
    const nextRevision = `revx${Date.now().toString(16)}`;
    const persist = await store.save({
      auth,
      requestId: `reqx${Date.now().toString(16)}`,
      expectedRevision: exportedCaseRevision,
      document: { ...(snapshot as unknown as Record<string, unknown>), revision: nextRevision },
      artifacts: [{
        id: artifactId,
        digest,
        mediaType: DOC_MEDIA,
        payload: JSON.stringify({ encoding: 'base64', bytes: bytes.toString('base64'), fileName }),
        sanitized: true,
        retention: 'case-revision',
      }],
    });

    let currentCaseRevision = exportedCaseRevision;
    if (persist.ok) currentCaseRevision = persist.revision;
    else {
      const again = await store.load({ ...auth, caseId: body.caseId });
      if (again.ok) currentCaseRevision = again.revision;
    }
    const revisionChangedDuringExport = !persist.ok && currentCaseRevision !== exportedCaseRevision;

    if (!persist.ok) {
      return {
        status: engineerCaseHttpStatus(persist),
        body: exportUnsaved(persist.code, {
          exportedCaseRevision,
          exportedGuideRevision,
          currentCaseRevision,
        }, persist.issues),
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        status: 'exported',
        downloadComplete: true,
        caseId: snapshot.caseId,
        artifactId,
        exportedCaseRevision,
        exportedGuideRevision,
        currentCaseRevision,
        revisionChangedDuringExport,
        ...grantsFalse(),
      },
    };
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

export async function getDownloadEngineerGuide(
  caseId: string | null,
  artifactId: string | null,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
): Promise<
  | { readonly status: number; readonly file: EngineerGuideDownloadFile }
  | { readonly status: number; readonly body: EngineerGuideExportFailure }
> {
  if (!auth) return { status: 401, body: exportUnsaved('SCOPE_UNAUTHORIZED') };
  const id = readEngineerCaseId(caseId);
  const artifact = readEngineerCaseId(artifactId);
  if (!id || !artifact) return { status: 400, body: exportUnsaved('VALIDATION_FAILED') };
  const loaded = await store.loadArtifact({ ...auth, caseId: id, artifactId: artifact });
  if (!loaded.ok) {
    return { status: engineerCaseHttpStatus(loaded), body: exportUnsaved(loaded.code, {}, loaded.issues) };
  }
  const parsed = parseStoredDocx(loaded.payload);
  if (!parsed || loaded.mediaType !== DOC_MEDIA) {
    return { status: 404, body: exportUnsaved('ARTIFACT_NOT_FOUND') };
  }
  return {
    status: 200,
    file: { bytes: parsed.bytes, fileName: parsed.fileName, mediaType: DOC_MEDIA },
  };
}

export function sendEngineerGuideDownload(
  res: http.ServerResponse,
  result: Awaited<ReturnType<typeof getDownloadEngineerGuide>>,
  writeJson: (res: http.ServerResponse, data: unknown, status?: number) => void,
): void {
  if ('file' in result) {
    res.writeHead(200, {
      'content-type': result.file.mediaType,
      'content-disposition': `attachment; filename="${result.file.fileName}"`,
      'cache-control': 'no-store',
    });
    res.end(result.file.bytes);
    return;
  }
  writeJson(res, result.body, result.status);
}
