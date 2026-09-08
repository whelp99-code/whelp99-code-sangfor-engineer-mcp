export const IAG_ORCHESTRATOR_STATES = [
  'RECEIVED', 'VALIDATING', 'PREFLIGHTING', 'DRY_RUN_COMPLETE',
  'NO_CHANGE_REQUIRED', 'AUTHORIZING', 'REFUSED', 'AUTHORIZED',
  'DISPATCHING', 'VERIFYING', 'SUCCEEDED', 'FAILED_HALT', 'INDETERMINATE',
] as const;

export type IagOrchestratorState = (typeof IAG_ORCHESTRATOR_STATES)[number];
export type IagTerminalState = Extract<IagOrchestratorState,
  | 'DRY_RUN_COMPLETE' | 'NO_CHANGE_REQUIRED' | 'REFUSED'
  | 'SUCCEEDED' | 'FAILED_HALT' | 'INDETERMINATE'>;

export function isIagTerminalState(state: IagOrchestratorState): state is IagTerminalState {
  switch (state) {
    case 'DRY_RUN_COMPLETE':
    case 'NO_CHANGE_REQUIRED':
    case 'REFUSED':
    case 'SUCCEEDED':
    case 'FAILED_HALT':
    case 'INDETERMINATE':
      return true;
    case 'RECEIVED':
    case 'VALIDATING':
    case 'PREFLIGHTING':
    case 'AUTHORIZING':
    case 'AUTHORIZED':
    case 'DISPATCHING':
    case 'VERIFYING':
      return false;
    default:
      state satisfies never;
      return false;
  }
}

export function isIagTransitionAllowed(
  from: IagOrchestratorState,
  to: IagOrchestratorState,
): boolean {
  switch (from) {
    case 'RECEIVED':
      return to === 'VALIDATING' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'VALIDATING':
      return to === 'PREFLIGHTING' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'PREFLIGHTING':
      return to === 'DRY_RUN_COMPLETE' || to === 'NO_CHANGE_REQUIRED'
        || to === 'AUTHORIZING' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'AUTHORIZING':
      return to === 'AUTHORIZED' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'AUTHORIZED':
      return to === 'DISPATCHING' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'DISPATCHING':
      return to === 'VERIFYING' || to === 'REFUSED' || to === 'INDETERMINATE';
    case 'VERIFYING':
      return to === 'SUCCEEDED' || to === 'FAILED_HALT' || to === 'INDETERMINATE';
    case 'DRY_RUN_COMPLETE':
    case 'NO_CHANGE_REQUIRED':
    case 'REFUSED':
    case 'SUCCEEDED':
    case 'FAILED_HALT':
    case 'INDETERMINATE':
      return false;
    default:
      from satisfies never;
      return false;
  }
}
