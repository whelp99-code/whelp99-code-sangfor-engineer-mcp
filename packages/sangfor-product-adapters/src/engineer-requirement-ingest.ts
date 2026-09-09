import type { EngineerCaseMode, EngineerRequirement } from '../../shared/src/engineer-case-contract.js';
import { importExcelRequirementList } from './excel-import.js';
import {
  assertEngineerRequirementFile,
  type EngineerRequirementGuardCode,
} from './engineer-requirement-guard.js';
import {
  applyUnconfirmedInferences,
  collectRequirementQuestions,
  mapExcelRowsToRequirements,
  mapTextsToRequirements,
} from './engineer-requirement-map.js';
import type { ExcelRequirementRow } from './types.js';

export type EngineerRequirementQuestionKind =
  | 'conflict'
  | 'duplicate'
  | 'ambiguous_unit'
  | 'missing'
  | 'unconfirmed_inference'
  | 'document_directive'
  | 'secret_redacted'
  | 'cross_customer_file';

export type EngineerRequirementQuestion = {
  readonly id: string;
  readonly kind: EngineerRequirementQuestionKind;
  readonly requirementIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly message: string;
};

export type EngineerRequirementTracking = {
  readonly trackedCount: number;
  readonly fixtureCount: number;
  readonly originalPresent: boolean;
  readonly synthetic: boolean;
  readonly claimedOriginal26: false;
  readonly label: string;
};

export type EngineerRequirementIngestInput = {
  readonly mode: EngineerCaseMode;
  readonly caseId: string;
  readonly projectId: string;
  readonly revision: string;
  readonly allowedRoot?: string;
  readonly filePath?: string;
  readonly sheetName?: string;
  readonly texts?: readonly string[];
  readonly rows?: readonly ExcelRequirementRow[];
  readonly originalPresent?: boolean;
  readonly unconfirmedInferences?: readonly { readonly text: string; readonly constraint: string }[];
};

export type EngineerRequirementIngestSuccess = {
  readonly ok: true;
  readonly mode: EngineerCaseMode;
  readonly requirements: readonly EngineerRequirement[];
  readonly questions: readonly EngineerRequirementQuestion[];
  readonly tracking: EngineerRequirementTracking;
  readonly observationsUntouched: true;
  readonly guideReadyGranted: false;
};

export type EngineerRequirementIngestFailure = {
  readonly ok: false;
  readonly code: EngineerRequirementGuardCode;
  readonly message: string;
};

export type EngineerRequirementIngestResult = EngineerRequirementIngestSuccess | EngineerRequirementIngestFailure;

function trackingFor(count: number, originalPresent: boolean): EngineerRequirementTracking {
  return {
    trackedCount: count,
    fixtureCount: count,
    originalPresent,
    synthetic: originalPresent !== true,
    claimedOriginal26: false,
    label: originalPresent === true
      ? `tracked ${count}/${count}`
      : `fixture ${count}/${count}; original 26-item source not present`,
  };
}

/**
 * Map customer text or the existing Excel parser into engineer-case requirements.
 * Requirement targets are never copied onto observations. Guide ready is never granted.
 */
export function ingestEngineerRequirements(input: EngineerRequirementIngestInput): EngineerRequirementIngestResult {
  const originalPresent = input.originalPresent === true;
  let rows = input.rows;
  let sheetName = 'inline';
  let allowedRoot = input.allowedRoot;

  if (input.filePath) {
    if (!input.allowedRoot) {
      return { ok: false, code: 'ALLOWED_ROOT_REQUIRED', message: 'allowedRoot is required for Excel ingest' };
    }
    const guarded = assertEngineerRequirementFile({
      filePath: input.filePath,
      allowedRoot: input.allowedRoot,
      projectId: input.projectId,
    });
    if (!guarded.ok) return guarded;
    try {
      const imported = importExcelRequirementList({
        filePath: guarded.resolvedPath,
        sheetName: input.sheetName,
        prioritizeOnly: false,
      });
      rows = imported.rows;
      sheetName = imported.sheetName;
      allowedRoot = input.allowedRoot;
    } catch {
      return { ok: false, code: 'MALFORMED_EXCEL', message: 'Excel could not be parsed as a checklist' };
    }
  }

  const mapped = rows
    ? mapExcelRowsToRequirements(rows, input, sheetName)
    : mapTextsToRequirements(input.texts ?? [], input);
  const requirements = applyUnconfirmedInferences(mapped.requirements, mapped.sourceTexts, input.unconfirmedInferences);
  return {
    ok: true,
    mode: input.mode,
    requirements,
    questions: collectRequirementQuestions(requirements, mapped.sourceTexts, allowedRoot),
    tracking: trackingFor(mapped.requirements.length, originalPresent),
    observationsUntouched: true,
    guideReadyGranted: false,
  };
}

export function ingestExcelRequirementsForCase(input: EngineerRequirementIngestInput): EngineerRequirementIngestResult {
  return ingestEngineerRequirements(input);
}

export function ingestTextRequirementsForCase(input: EngineerRequirementIngestInput): EngineerRequirementIngestResult {
  return ingestEngineerRequirements(input);
}
