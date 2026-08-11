import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  isReadOnlyEvidenceLabel,
  maskSensitiveMetadataText,
} from '../../sangfor-browser-contracts/src/index.js';
import { AuditLedger } from '../../sangfor-hci-client/src/index.js';
import { nowId } from '../../shared/src/index.js';
import {
  buildCaptureFilePath,
  formatDateStamp,
  normalizeCaptureSegment,
  resolveConfinedOutputDir,
  sha256File,
} from './console-evidence-paths.js';
import type {
  CaptureConsoleEvidenceDeps,
  CaptureConsoleEvidenceInput,
  CaptureConsoleEvidenceResult,
  ConsoleCaptureItemResult,
  ConsoleCaptureRequest,
} from './console-evidence-types.js';

export {
  CAPTURE_EVIDENCE_ROOT_ENV_VAR,
  DEFAULT_CONSOLE_CDP_PORT,
  formatDateStamp,
  resolveConfinedOutputDir,
} from './console-evidence-paths.js';
export * from './console-evidence-types.js';
export { verifyCaptureLedger } from './console-evidence-verification.js';

function findDestructiveLabel(item: ConsoleCaptureRequest): string | null {
  const candidates = [
    item.menuLabel,
    ...(item.menuPath ?? []).flatMap((step) => [
      step.menu,
      ...(step.submenu ? [step.submenu] : []),
    ]),
  ];
  return candidates.find((candidate) => !isReadOnlyEvidenceLabel(candidate)) ?? null;
}

function ledgerPayload(
  record: ConsoleCaptureItemResult,
  input: CaptureConsoleEvidenceInput,
) {
  return {
    reqId: maskSensitiveMetadataText(record.reqId),
    menuLabel: maskSensitiveMetadataText(record.menuLabel),
    filePath: record.filePath,
    sha256: record.sha256,
    capturedAt: record.capturedAt,
    ok: record.ok,
    ...(record.error
      ? { error: maskSensitiveMetadataText(record.error) }
      : {}),
    product: input.product,
    engagementId: input.engagementId
      ? maskSensitiveMetadataText(input.engagementId)
      : undefined,
  };
}

export async function captureConsoleEvidence(
  input: CaptureConsoleEvidenceInput,
  deps: CaptureConsoleEvidenceDeps = {},
): Promise<CaptureConsoleEvidenceResult> {
  const dateStamp = input.dateStamp ?? formatDateStamp(new Date());
  const ledger = deps.ledger ?? new AuditLedger();
  const runId = nowId('console_capture');
  const outputDir = resolveConfinedOutputDir(input.outputDir);
  if (!deps.executionPort || !deps.sessionId || !deps.origin) {
    throw new Error(
      'BROWSER_EXECUTION_PORT_REQUIRED: sessionId and origin are required.',
    );
  }

  const results: ConsoleCaptureItemResult[] = [];
  for (const item of input.captures) {
    const maskedReqId = maskSensitiveMetadataText(item.reqId);
    const maskedMenuLabel = maskSensitiveMetadataText(item.menuLabel);
    const filePath = buildCaptureFilePath(
      outputDir,
      maskedReqId,
      input.product,
      maskedMenuLabel,
      dateStamp,
    );
    const safeRequestId = normalizeCaptureSegment(maskedReqId);
    const capturedAt = new Date().toISOString();
    const destructiveLabel = findDestructiveLabel(item);
    if (destructiveLabel) {
      const record: ConsoleCaptureItemResult = {
        reqId: item.reqId,
        menuLabel: item.menuLabel,
        filePath,
        sha256: null,
        capturedAt,
        ok: false,
        error: `REFUSED_DESTRUCTIVE_MENU_LABEL: ${destructiveLabel}`,
      };
      results.push(record);
      ledger.append(runId, 'response', ledgerPayload(record, input));
      continue;
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (item.url) {
        const navigation = await deps.executionPort.execute({
          schemaVersion: 'browser-execution-request.v1',
          requestId: `${runId}-${safeRequestId}-navigate`,
          sessionId: deps.sessionId,
          origin: deps.origin,
          operation: {
            kind: 'perform_console_action',
            action: { type: 'navigate', target: item.url, dryRun: true },
          },
        });
        if (navigation.status !== 'PASS') {
          throw new Error(
            navigation.error?.message ?? `Navigation result: ${navigation.status}`,
          );
        }
      }
      const capture = await deps.executionPort.execute({
        schemaVersion: 'browser-execution-request.v1',
        requestId: `${runId}-${safeRequestId}-capture`,
        sessionId: deps.sessionId,
        origin: deps.origin,
        operation: {
          kind: 'capture_console_evidence',
          captureId: safeRequestId,
          menuPath: item.menuPath?.length
            ? item.menuPath
            : [{ menu: item.menuLabel }],
        },
      });
      const artifactRef = capture.evidence[0]?.artifactRef;
      if (capture.status !== 'PASS' || !artifactRef) {
        throw new Error(
          capture.error?.message ?? `Capture result: ${capture.status}`,
        );
      }
      if (!deps.materializeArtifact) {
        throw new Error(
          'JM_ARTIFACT_MATERIALIZER_REQUIRED: opaque artifact references require JM materialization.',
        );
      }
      await deps.materializeArtifact(artifactRef, filePath);
      const record: ConsoleCaptureItemResult = {
        reqId: item.reqId,
        menuLabel: item.menuLabel,
        filePath,
        sha256: sha256File(filePath),
        capturedAt,
        ok: true,
      };
      results.push(record);
      ledger.append(runId, 'response', ledgerPayload(record, input));
    } catch (error) {
      const record: ConsoleCaptureItemResult = {
        reqId: item.reqId,
        menuLabel: item.menuLabel,
        filePath,
        sha256: null,
        capturedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(record);
      ledger.append(runId, 'response', ledgerPayload(record, input));
    }
  }

  return {
    runId,
    outputDir,
    captures: results,
    ledgerPath: ledger.pathFor(runId),
    chainOk: ledger.verify(runId).ok,
  };
}
