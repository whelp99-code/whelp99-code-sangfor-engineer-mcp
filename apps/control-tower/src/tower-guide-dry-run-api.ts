import { BridgeClient } from './bridge-client.js';
import { ApiError } from './tower-contract.js';

const GUIDE_DRY_RUN_TOOL = 'sangfor_engineer_guide_dry_run';

export type GuideBoundDryRun = (input: unknown) => Promise<unknown>;

export type GuideDryRunRequest = {
  readonly actionPath: string;
  readonly configPath: string;
  readonly guidePath: string;
  readonly observedPath: string;
  readonly proposalPath?: string;
  readonly approvalEnvelopePath?: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly approval?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'IAG_GUIDE_DRY_RUN_INPUT_INVALID');
  }
  return value as Record<string, unknown>;
}

function pathArgs(input: GuideDryRunRequest): Record<string, string> {
  return {
    actionPath: input.actionPath,
    configPath: input.configPath,
    guidePath: input.guidePath,
    observedPath: input.observedPath,
    ...(input.proposalPath === undefined ? {} : { proposalPath: input.proposalPath }),
  };
}

function refuseMutationControls(input: GuideDryRunRequest): void {
  if (input.approvalEnvelopePath !== undefined || input.approval !== undefined) {
    throw new ApiError(400, 'IAG_DRY_RUN_APPROVAL_REFUSED');
  }
  if (input.apply === true) throw new ApiError(400, 'IAG_GUIDE_APPLY_REFUSED');
  if (input.dryRun === false) throw new ApiError(400, 'IAG_DRY_RUN_ACTION_REQUIRED');
}

function sealReadOnly(result: unknown): Record<string, unknown> {
  const record = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>) }
    : { result };
  return { ...record, verifiedSuccess: false, mutationAttempted: false };
}

function rethrowGuideRefusal(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:IAG_|HCI_|STALE_|PROPOSAL_|PRESTATE_|SINGLE_GUIDE_)/u.test(message)) {
    throw new ApiError(400, message);
  }
  throw error;
}

export function createBridgeGuideBoundDryRun(client: BridgeClient): GuideBoundDryRun {
  return async (input) => {
    const call = await client.callTool(GUIDE_DRY_RUN_TOOL, asRecord(input));
    if (!call.ok) throw new ApiError(400, call.errorText ?? 'IAG_GUIDE_DRY_RUN_REFUSED');
    return call.data;
  };
}

export function createGuideDryRunApi(deps: { readonly dryRunBoundToGuide: GuideBoundDryRun }) {
  return {
    async dryRunEngineerGuide(input: GuideDryRunRequest): Promise<Record<string, unknown>> {
      refuseMutationControls(input);
      try {
        return sealReadOnly(await deps.dryRunBoundToGuide(pathArgs(input)));
      } catch (error) {
        rethrowGuideRefusal(error);
      }
    },
  };
}
