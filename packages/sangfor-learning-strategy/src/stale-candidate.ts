export interface StaleCandidate {
  revisionId: string;
  strategyId: string;
  reason: string;
  detectedAt: string;
  confirmed: boolean;
}

export function createStaleCandidate(
  revisionId: string,
  strategyId: string,
  reason: string,
): StaleCandidate {
  return {
    revisionId,
    strategyId,
    reason,
    detectedAt: new Date().toISOString(),
    confirmed: false,
  };
}

export function confirmStaleCandidate(candidate: StaleCandidate): StaleCandidate {
  return { ...candidate, confirmed: true };
}
