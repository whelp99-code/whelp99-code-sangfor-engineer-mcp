/**
 * Persist a reduced guide-file envelope for E13 dry-run.
 *
 * E07 `EngineerGuideStepView` extras never become grants. `executable` is
 * copied from the already-computed view. This writer does not apply, does
 * not grant field_accepted, and does not change the engineer-case document.
 */
import { writeFileAtomicSync } from '@sangfor/shared';
import type { EngineerGuide } from '../../../shared/src/engineer-case-contract.js';
import type { EngineerGuideApplyStepView } from './engineer-guide-apply-bind.js';

export type EngineerGuideStepViewSource = {
  readonly step: { readonly id: string };
  readonly executable: boolean;
  readonly support: EngineerGuideApplyStepView['support'];
};

export type EngineerGuideApplyFile = {
  readonly product: 'IAG' | 'HCI';
  readonly guide: EngineerGuide;
  readonly stepViews: readonly EngineerGuideApplyStepView[];
};

export function mapEngineerGuideStepViewToStored(
  view: EngineerGuideStepViewSource,
): EngineerGuideApplyStepView {
  return {
    stepId: view.step.id,
    executable: view.executable,
    support: view.support,
  };
}

export function toEngineerGuideApplyFile(input: {
  readonly product: 'IAG' | 'HCI';
  readonly guide: EngineerGuide;
  readonly stepViews: readonly EngineerGuideStepViewSource[];
}): EngineerGuideApplyFile {
  return {
    product: input.product,
    guide: input.guide,
    stepViews: input.stepViews.map(mapEngineerGuideStepViewToStored),
  };
}

export function writeEngineerGuideApplyFile(input: {
  readonly outputPath: string;
  readonly product: 'IAG' | 'HCI';
  readonly guide: EngineerGuide;
  readonly stepViews: readonly EngineerGuideStepViewSource[];
}): EngineerGuideApplyFile {
  const file = toEngineerGuideApplyFile(input);
  writeFileAtomicSync(input.outputPath, JSON.stringify(file));
  return file;
}
