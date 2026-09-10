/**
 * Persist-adjacent E13 envelope export.
 *
 * Case persist still stores a bare EngineerGuide. This module writes the
 * reduced `{ product, guide, stepViews }` file beside persist by calling the
 * existing mapper. It does not apply, does not invent executable, and does
 * not grant field_accepted.
 */
import {
  parseEngineerCaseDocument,
  type EngineerGuide,
} from '../../../shared/src/engineer-case-contract.js';
import type {
  EngineerCaseSaveRequest,
  EngineerCaseSaveResult,
} from '@sangfor/authority';
import {
  writeEngineerGuideApplyFile,
  type EngineerGuideApplyFile,
  type EngineerGuideStepViewSource,
} from './engineer-guide-apply-file.js';

export type EngineerGuideApplyProduct = EngineerGuideApplyFile['product'];

export type EngineerGuideApplyExportOmitted =
  | 'unknown_product'
  | 'missing_step_views'
  | 'persist_failed'
  | 'path_not_provided';

export type EngineerGuideApplyPersistExport =
  | {
      readonly written: EngineerGuideApplyFile;
      readonly outputPath: string;
      readonly omitted?: undefined;
      readonly unresolved?: undefined;
    }
  | {
      readonly written: undefined;
      readonly omitted: Exclude<EngineerGuideApplyExportOmitted, 'persist_failed' | 'path_not_provided'>;
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
 * Persist the engineer case, then emit the dry-run envelope from already
 * computed E07 step views. Persist success does not depend on the export.
 */
export async function persistEngineerCaseAndGuideApplyFile(input: {
  readonly persist: (request: EngineerCaseSaveRequest) => Promise<EngineerCaseSaveResult>;
  readonly save: EngineerCaseSaveRequest;
  readonly stepViews?: readonly EngineerGuideStepViewSource[];
  readonly guide?: EngineerGuide;
  readonly outputPath?: string;
}): Promise<PersistEngineerCaseGuideApplyResult> {
  const persist = await input.persist(input.save);
  if (!persist.ok) {
    return { persist, applyFileOmitted: 'persist_failed' };
  }
  if (input.outputPath === undefined) {
    return { persist, applyFileOmitted: 'path_not_provided' };
  }

  let product: string | undefined;
  let guide = input.guide;
  try {
    const source = typeof input.save.document === 'string'
      ? input.save.document
      : JSON.stringify(input.save.document);
    const document = parseEngineerCaseDocument(source);
    product = document.product;
    guide ??= document.guide;
  } catch {
    return {
      persist,
      applyFileOmitted: 'unknown_product',
      unresolved: 'GUIDE_APPLY_PRODUCT_UNRESOLVED',
    };
  }
  if (guide === undefined) {
    return { persist, applyFileOmitted: 'missing_step_views' };
  }

  const exported = exportPersistedEngineerGuideApplyFile({
    outputPath: input.outputPath,
    product,
    guide,
    stepViews: input.stepViews,
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
