export class PromotionLedgerUnavailableError extends Error {
  readonly name = 'PromotionLedgerUnavailableError';
  constructor() { super('CAPABILITY_PROMOTION_LEDGER_UNAVAILABLE'); }
}

export class PromotionLedgerIndeterminateError extends Error {
  readonly name = 'PromotionLedgerIndeterminateError';
  constructor() { super('CAPABILITY_PROMOTION_LEDGER_COMMIT_UNKNOWN'); }
}

export class PromotionLedgerStaleStateError extends Error {
  readonly name = 'PromotionLedgerStaleStateError';
  constructor() { super('CAPABILITY_PROMOTION_STALE_MATURITY'); }
}
