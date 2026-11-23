/**
 * Read-only file-bound IAG dry-run for one engineer-guide step.
 * Mutation stays closed. A 2xx is never success. Fixture PASS is not field_accepted.
 */
import { z } from 'zod';
import { resolveIagMutationActionAuthority } from '../../../packages/sangfor-competency/src/index.js';
import type { ResolveIagMutationActionAuthorityInput } from '../../../packages/sangfor-competency/src/index.js';
import {
  digestIagMutationAction,
  parseIagMutationAction,
} from '../../../packages/sangfor-product-adapters/src/apply/iag-action-authority.js';
import type { IagExecutor } from '../../../packages/sangfor-product-adapters/src/apply/iag-executor.js';
import {
  structuralIagExpectedStateSchema,
  structuralIagMutationActionSchema,
  structuralIagObservedStateSchema,
  structuralIagUnavailableStateSchema,
} from '../../../packages/sangfor-product-adapters/src/apply/iag-mutation-action.js';
import {
  dryRunEngineerGuideApply,
  proposeEngineerGuideApply,
  type EngineerGuideApplyDryRunResult,
  type EngineerGuideApplyObserved,
  type EngineerGuideApplyProposal,
  type EngineerGuideApplyStepView,
} from '../../../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import {
  ENGINEER_DIGEST_RE,
  ENGINEER_GUIDE_READINESS,
  ENGINEER_ID_RE,
  type EngineerGuide,
} from '../../../packages/shared/src/engineer-case-contract.js';
import { computeEngineerGuideDigest } from '../../../packages/shared/src/engineer-guide-digest.js';

const pathSchema = z.string().min(1).max(4096);
export const boundGuideDryRunInputSchema = z.object({
  actionPath: pathSchema,
  configPath: pathSchema,
  guidePath: pathSchema,
  observedPath: pathSchema,
  approvalEnvelopePath: pathSchema.optional(),
  proposalPath: pathSchema.optional(),
}).strict();

const engineerId = z.string().regex(ENGINEER_ID_RE).refine(
  (value) => value !== '.' && value !== '..' && !value.includes('..'),
);
const guideStepSchema = z.object({
  id: engineerId,
  order: z.number().int().positive(),
  title: z.string().min(1).max(256),
  requirementRefs: z.array(engineerId).max(16),
  currentRef: engineerId.optional(),
  proposedRef: engineerId.optional(),
  evidenceRefs: z.array(engineerId).max(16),
  citations: z.array(z.string().min(1).max(256)).max(16),
  verify: z.string().min(1).max(1024),
  stop: z.string().min(1).max(1024),
  recovery: z.string().min(1).max(1024),
}).strict();
const guideSchema = z.object({
  revision: engineerId,
  digest: z.string().regex(ENGINEER_DIGEST_RE),
  requirementRefs: z.array(engineerId).max(64),
  steps: z.array(guideStepSchema).max(64),
  prerequisites: z.array(z.string().min(1).max(512)).max(32),
  unresolved: z.array(z.string().min(1).max(512)).max(64),
  readiness: z.enum(ENGINEER_GUIDE_READINESS),
}).strict();
const storedStepViewSchema = z.object({
  stepId: engineerId,
  executable: z.boolean(),
  support: z.enum(['executable', 'blocked', 'unsupported']),
}).strict();
const guideFileSchema = z.union([
  guideSchema,
  z.object({
    product: z.enum(['IAG', 'HCI']),
    guide: guideSchema,
    stepViews: z.array(storedStepViewSchema).max(64).optional(),
  }).strict(),
]);
const observedFileSchema = z.union([
  structuralIagObservedStateSchema,
  structuralIagUnavailableStateSchema,
  z.object({
    kind: z.literal('INDETERMINATE'),
    reasonCode: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
  }).strict(),
]);
const digestSchema = z.string().regex(ENGINEER_DIGEST_RE);
const proposalFileSchema = z.object({
  digest: digestSchema,
  guideRevision: engineerId,
  guideDigest: digestSchema,
  stepId: engineerId,
  product: z.literal('IAG'),
  actionDigest: digestSchema,
  before: structuralIagObservedStateSchema,
  after: structuralIagExpectedStateSchema,
  action: structuralIagMutationActionSchema,
}).strict();

function refuse(code: string): EngineerGuideApplyDryRunResult {
  return {
    ok: false, code, mutationAttempted: false, retry: false,
    verifiedSuccess: false, httpSuccessIgnored: true,
  };
}

function loadGuide(raw: unknown): {
  readonly product: 'IAG' | 'HCI';
  readonly guide: EngineerGuide;
  readonly storedStepViews: readonly EngineerGuideApplyStepView[];
} {
  const parsed = guideFileSchema.parse(raw);
  if ('guide' in parsed) {
    return {
      product: parsed.product,
      guide: parsed.guide,
      storedStepViews: parsed.stepViews ?? [],
    };
  }
  return { product: 'IAG', guide: parsed, storedStepViews: [] };
}

function loadObserved(raw: unknown): EngineerGuideApplyObserved {
  const parsed = observedFileSchema.parse(raw);
  if (parsed.kind === 'UNAVAILABLE') return parsed;
  if (parsed.kind === 'INDETERMINATE') {
    return { kind: 'UNAVAILABLE', reasonCode: parsed.reasonCode ?? 'PRESTATE_INDETERMINATE' };
  }
  return parsed;
}

export async function executeEngineerGuideBoundDryRun(input: {
  readonly actionSource: string;
  readonly guideRaw: unknown;
  readonly observedRaw: unknown;
  readonly proposalRaw?: unknown;
  readonly executor: IagExecutor;
  readonly authorityRequest: ResolveIagMutationActionAuthorityInput;
}): Promise<EngineerGuideApplyDryRunResult> {
  const loadedGuide = loadGuide(input.guideRaw);
  if (loadedGuide.product === 'HCI') return refuse('HCI_GUIDE_APPLY_UNSUPPORTED');
  const { digest, ...guideBody } = loadedGuide.guide;
  if (computeEngineerGuideDigest(guideBody) !== digest) return refuse('STALE_GUIDE');
  const currentObserved = loadObserved(input.observedRaw);

  const authority = await resolveIagMutationActionAuthority(
    input.authorityRequest,
    { persistStaleness: false },
  );
  if (!authority.ok) return refuse(authority.code);
  const parsedAction = parseIagMutationAction({
    source: input.actionSource,
    authority: authority.authority,
  });
  if (!parsedAction.ok) return refuse(parsedAction.refusal.code.toUpperCase());
  const fileAction = parsedAction.value;
  const stepId = loadedGuide.guide.steps[0]?.id;
  if (stepId === undefined) return refuse('SINGLE_GUIDE_STEP_REQUIRED');

  let proposal: EngineerGuideApplyProposal;
  if (input.proposalRaw !== undefined) {
    const loaded = proposalFileSchema.parse(input.proposalRaw);
    if (loaded.actionDigest !== digestIagMutationAction(fileAction)) return refuse('PROPOSAL_TAMPERED');
    const reboundAction = parseIagMutationAction({
      source: JSON.stringify(loaded.action),
      authority: authority.authority,
    });
    if (!reboundAction.ok) return refuse('PROPOSAL_TAMPERED');
    proposal = { ...loaded, action: reboundAction.value };
  } else {
    const proposed = proposeEngineerGuideApply({
      guide: loadedGuide.guide,
      storedStepViews: loadedGuide.storedStepViews,
      stepViews: [],
      stepId,
      product: 'IAG',
      action: fileAction,
      currentObserved,
    });
    if (!proposed.ok) {
      return {
        ok: false, code: proposed.code, mutationAttempted: false, retry: false,
        verifiedSuccess: false, httpSuccessIgnored: true,
      };
    }
    proposal = proposed.proposal;
  }

  return dryRunEngineerGuideApply({
    proposal,
    currentGuide: loadedGuide.guide,
    currentObserved,
    storedStepViews: loadedGuide.storedStepViews,
    stepViews: [],
    executor: input.executor,
    authorityRequest: input.authorityRequest,
  });
}
