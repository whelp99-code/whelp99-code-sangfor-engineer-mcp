export class IagOrchestratorStoreUnavailableError extends Error {
  readonly name = 'IagOrchestratorStoreUnavailableError';
  constructor() { super('IAG_ORCHESTRATOR_STORE_UNAVAILABLE'); }
}

export class IagOrchestratorStoreIndeterminateError extends Error {
  readonly name = 'IagOrchestratorStoreIndeterminateError';
  constructor() { super('IAG_ORCHESTRATOR_STORE_ACKNOWLEDGEMENT_UNCERTAIN'); }
}

export class IagRunNotFoundError extends Error {
  readonly name = 'IagRunNotFoundError';
  constructor(readonly runId: string) { super(`IAG_RUN_NOT_FOUND:${runId}`); }
}
