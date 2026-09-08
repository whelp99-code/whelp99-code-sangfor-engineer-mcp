const groundedActions = new WeakSet<object>();
const groundedProofs = new WeakMap<object, object>();
const groundedResults = new WeakMap<object, { readonly action: object; readonly proof: object | undefined }>();

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function registerGroundedAction<T extends object>(action: T): T {
  const frozen = deepFreeze(action);
  groundedActions.add(frozen);
  return frozen;
}

export function isGroundedAction(value: unknown): value is object {
  return typeof value === 'object' && value !== null && groundedActions.has(value);
}

export function registerGroundedProof<T extends object>(proof: T, action: object): T {
  const frozen = deepFreeze(proof);
  groundedProofs.set(frozen, action);
  return frozen;
}

export function isGroundedProof(proof: unknown): proof is object {
  return typeof proof === 'object' && proof !== null && groundedProofs.has(proof);
}

export function proofMatchesAction(proof: unknown, action: object): proof is object {
  return typeof proof === 'object' && proof !== null && groundedProofs.get(proof) === action;
}

export function registerGroundedResult<T extends object>(result: T, action: object, proof: object | undefined): T {
  const frozen = deepFreeze(result);
  groundedResults.set(frozen, { action, proof });
  return frozen;
}

export function resultMatchesAuthority(result: unknown, action: object, proof: object | undefined): result is object {
  if (typeof result !== 'object' || result === null) return false;
  const authority = groundedResults.get(result);
  return authority?.action === action && authority.proof === proof;
}
