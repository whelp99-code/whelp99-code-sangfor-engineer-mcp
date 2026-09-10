/**
 * Persist-adjacent E13 envelope export.
 *
 * Case persist still stores a bare EngineerGuide. This module writes the
 * reduced `{ product, guide, stepViews }` file beside persist by calling the
 * existing mapper. Caller-supplied stepViews are not grants: only views
 * derived from buildEngineerGuide (injected) may be exported. It does not
 * apply, does not invent executable, and does not grant field_accepted.
 */
import { join } from 'node:path';
import {
  ENGINEER_ID_RE,
  parseEngineerCaseDocument,
  type EngineerCaseDocument,
  type EngineerGuide,
} from '../../../shared/src/engineer-case-contract.js';
import type {
  EngineerCaseSaveRequest,
  EngineerCaseSaveResult,
} from '@sangfor/authority';
import {
  mapEngineerGuideStepViewToStored,
  writeEngineerGuideApplyFile,
  type EngineerGuideApplyFile,
  type EngineerGuideStepViewSource,
} from './engineer-guide-apply-file.js';

export type EngineerGuideApplyProduct = EngineerGuideApplyFile['product'];

export type EngineerGuideApplyExportOmitted =
  | 'unknown_product'
  | 'missing_step_views'
  | 'persist_failed'
  | 'path_not_provided'
  | 'forged_step_views';

export type EngineerGuideApplyDerivedViews = {
  readonly guide: EngineerGuide;
  readonly stepViews: readonly EngineerGuideStepViewSource[];
};

export type EngineerGuideApplyDerive = (input: {
  readonly document: EngineerCaseDocument;
  readonly auth: EngineerCaseSaveRequest['auth'];
}) => EngineerGuideApplyDerivedViews | undefined;

export type EngineerGuideApplyPersistExport =
  | {
      readonly written: EngineerGuideApplyFile;
      readonly outputPath: string;
      readonly omitted?: undefined;
      readonly unresolved?: undefined;
    }
  | {
      readonly written: undefined;
      readonly omitted: Exclude<EngineerGuideApplyExportOmitted, 'persist_failed' | 'path_not_provided' | 'forged_step_views'>;
      readonly unresolved?: string;
    };

export type PersistEngineerCaseGuideApplyResult = {
  readonly persist: EngineerCaseSaveResult;
  readonly applyFile?: EngineerGuideApplyFile;
  readonly applyFilePath?: string;
  readonly applyFileOmitted?: EngineerGuideApplyExportOmitted;
  readonly unresolved?: string;
};

/**
 * Map evidenced case product codes onto the dry-run envelope.
 * Unknown is not IAG. HCI_SCP is evidenced HCI, not a guess.
 */
export function resolveEngineerGuideApplyProduct(
  product: string | undefined,
): EngineerGuideApplyProduct | undefined {
  if (product === 'IAG') return 'IAG';
  if (product === 'HCI' || product === 'HCI_SCP') return 'HCI';
  return undefined;
}

function storedViewIdentity(view: EngineerGuideStepViewSource): string {
  const stored = mapEngineerGuideStepViewToStored(view);
  return `${stored.stepId}\0${stored.executable ? '1' : '0'}\0${stored.support}`;
}

function sameStoredStepViews(
  left: readonly EngineerGuideStepViewSource[],
  right: readonly EngineerGuideStepViewSource[],
): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(storedViewIdentity).sort();
  const b = right.map(storedViewIdentity).sort();
  return a.every((value, index) => value === b[index]);
}

function isSafeEngineerPathId(value: string): boolean {
  return ENGINEER_ID_RE.test(value) && value !== '.' && value !== '..' && !value.includes('..');
}

function resolveApplyOutputPath(input: {
  readonly outputPath?: string;
  readonly outputRoot?: string;
  readonly caseId: string;
  readonly guideRevision: string;
}): string | undefined {
  if (input.outputPath !== undefined) return input.outputPath;
  if (input.outputRoot === undefined) return undefined;
  if (!isSafeEngineerPathId(input.caseId) || !isSafeEngineerPathId(input.guideRevision)) return undefined;
  return join(input.outputRoot, `${input.caseId}-${input.guideRevision}.guide-apply.json`);
}

export function exportPersistedEngineerGuideApplyFile(input: {
  readonly outputPath: string;
  readonly product: string | undefined;
  readonly guide: EngineerGuide;
  readonly stepViews?: readonly EngineerGuideStepViewSource[];
}): EngineerGuideApplyPersistExport {
  const product = resolveEngineerGuideApplyProduct(input.product);
  if (product === undefined) {
    return {
      written: undefined,
      omitted: 'unknown_product',
      unresolved: 'GUIDE_APPLY_PRODUCT_UNRESOLVED',
    };
  }
  const stepViews = input.stepViews ?? [];
  if (stepViews.length === 0) {
    return { written: undefined, omitted: 'missing_step_views' };
  }
  return {
    written: writeEngineerGuideApplyFile({
      outputPath: input.outputPath,
      product,
      guide: input.guide,
      stepViews,
    }),
    outputPath: input.outputPath,
  };
}

/**
 * Persist the engineer case, then emit the dry-run envelope from derived
 * E07 step views. Caller stepViews cannot grant. Persist success does not
 * depend on the export.
 */
export async function persistEngineerCaseAndGuideApplyFile(input: {
  readonly persist: (request: EngineerCaseSaveRequest) => Promise<EngineerCaseSaveResult>;
  readonly save: EngineerCaseSaveRequest;
  readonly stepViews?: readonly EngineerGuideStepViewSource[];
  readonly guide?: EngineerGuide;
  readonly outputPath?: string;
  readonly outputRoot?: string;
  readonly derive?: EngineerGuideApplyDerive;
}): Promise<PersistEngineerCaseGuideApplyResult> {
  const persist = await input.persist(input.save);
  if (!persist.ok) {
    return { persist, applyFileOmitted: 'persist_failed' };
  }

  let document: EngineerCaseDocument;
  try {
    const source = typeof input.save.document === 'string'
      ? input.save.document
      : JSON.stringify(input.save.document);
    document = parseEngineerCaseDocument(source);
  } catch {
    return {
      persist,
      applyFileOmitted: 'unknown_product',
      unresolved: 'GUIDE_APPLY_PRODUCT_UNRESOLVED',
    };
  }

  let derived: EngineerGuideApplyDerivedViews | undefined;
  try {
    derived = input.derive?.({ document, auth: input.save.auth });
  } catch {
    derived = undefined;
  }
  if (derived === undefined || derived.stepViews.length === 0) {
    return { persist, applyFileOmitted: 'missing_step_views' };
  }
  if (input.stepViews !== undefined && !sameStoredStepViews(input.stepViews, derived.stepViews)) {
    return { persist, applyFileOmitted: 'forged_step_views' };
  }

  const outputPath = resolveApplyOutputPath({
    outputPath: input.outputPath,
    outputRoot: input.outputRoot,
    caseId: document.caseId,
    guideRevision: derived.guide.revision,
  });
  if (outputPath === undefined) {
    return { persist, applyFileOmitted: 'path_not_provided' };
  }

  const exported = exportPersistedEngineerGuideApplyFile({
    outputPath,
    product: document.product,
    guide: derived.guide,
    stepViews: derived.stepViews,
  });
  if (exported.written === undefined) {
    return {
      persist,
      applyFileOmitted: exported.omitted,
      unresolved: exported.unresolved,
    };
  }
  return {
    persist,
    applyFile: exported.written,
    applyFilePath: exported.outputPath,
  };
}
