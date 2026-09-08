import type { PromotionLedgerEvent } from './promotion-ledger.js';
import type { Maturity } from './schema.js';

export type CapabilityPromotionResult =
  | { readonly status: 'applied'; readonly effectiveMaturity: Maturity; readonly event: PromotionLedgerEvent }
  | { readonly status: 'refused'; readonly effectiveMaturity: Maturity; readonly refusalCode: string; readonly event?: PromotionLedgerEvent }
  | { readonly status: 'indeterminate'; readonly reason: 'ledger_commit_unknown' | 'ledger_state_unknown' };

export const promotionIndeterminate = (
  reason: 'ledger_commit_unknown' | 'ledger_state_unknown' = 'ledger_commit_unknown',
): CapabilityPromotionResult => ({ status: 'indeterminate', reason });
