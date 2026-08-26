export class IagOrchestratorStoreUnavailableError extends Error {
  readonly name = 'IagOrchestratorStoreUnavailableError';
  constructor() { super('IAG_ORCHESTRATOR_STORE_UNAVAILABLE'); }
}

export class IagOrchestratorStoreIndeterminateError extends Error {
  readonly name = 'IagOrchestratorStoreIndeterminateError';
  constructor() { super('IAG_ORCHESTRATOR_STORE_ACKNOWLEDGEMENT_UNCERTAIN'); }
}
