import type { StrategyState, StrategyRevision } from './store.js';

/**
 * PR-001C: Lifecycle fold with strategy_field_verified vs competency non-counting boundary.
 * 
 * Key invariant: strategy_field_verified is a reproducibility state for the strategy,
 * NOT a competency field_verified. Strategy promotion alone does NOT auto-count
 * toward replacementRate.
 */

export interface LifecycleTransition {
  from: StrategyState;
  to: StrategyState;
  requiredEvidence: string[];
  requiresHumanHmac: boolean;
}

export const VALID_TRANSITIONS: LifecycleTransition[] = [
  {
    from: 'draft',
    to: 'researched',
    requiredEvidence: ['LR-01~LR-04 valid evidence'],
    requiresHumanHmac: true,
  },
  {
    from: 'researched',
    to: 'lab_verified',
    requiredEvidence: ['exact lab target verification', 'real file evidence'],
    requiresHumanHmac: true,
  },
  {
    from: 'lab_verified',
    to: 'device_verified',
    requiredEvidence: ['exact physical/virtual device verification', 'real file evidence'],
    requiresHumanHmac: true,
  },
  {
    from: 'device_verified',
    to: 'strategy_field_verified',
    requiredEvidence: ['field success 1x', 'required fact completeness', 'real file evidence'],
    requiresHumanHmac: true,
  },
  {
    from: 'draft',
    to: 'stale',
    requiredEvidence: ['human HMAC or verified integrity/mutation safety event'],
    requiresHumanHmac: true,
  },
  {
    from: 'researched',
    to: 'stale',
    requiredEvidence: ['human HMAC or verified integrity/mutation safety event'],
    requiresHumanHmac: true,
  },
  {
    from: 'lab_verified',
    to: 'stale',
    requiredEvidence: ['human HMAC or verified integrity/mutation safety event'],
    requiresHumanHmac: true,
  },
  {
    from: 'device_verified',
    to: 'stale',
    requiredEvidence: ['human HMAC or verified integrity/mutation safety event'],
    requiresHumanHmac: true,
  },
  {
    from: 'strategy_field_verified',
    to: 'stale',
    requiredEvidence: ['human HMAC or verified integrity/mutation safety event'],
    requiresHumanHmac: true,
  },
  {
    from: 'draft',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
  {
    from: 'researched',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
  {
    from: 'lab_verified',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
  {
    from: 'device_verified',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
  {
    from: 'strategy_field_verified',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
  {
    from: 'stale',
    to: 'deprecated',
    requiredEvidence: ['human HMAC'],
    requiresHumanHmac: true,
  },
];

export function isValidTransition(from: StrategyState, to: StrategyState): boolean {
  return VALID_TRANSITIONS.some(t => t.from === from && t.to === to);
}

export function getTransitionRequirements(from: StrategyState, to: StrategyState): LifecycleTransition | null {
  return VALID_TRANSITIONS.find(t => t.from === from && t.to === to) ?? null;
}

export function isTerminalState(state: StrategyState): boolean {
  return state === 'deprecated';
}

export function isUsableState(state: StrategyState): boolean {
  return ['researched', 'lab_verified', 'device_verified', 'strategy_field_verified'].includes(state);
}

export function canRecoverFromStale(state: StrategyState): boolean {
  // stale revision은 복구하지 않고 derivedFromRevisionId를 가진 새 draft를 만든다
  return false;
}

export interface LifecycleEvent {
  eventType: 'transition' | 'stale_candidate' | 'system_stale';
  fromState: StrategyState;
  toState: StrategyState;
  revisionId: string;
  timestamp: string;
  evidenceFile?: string;
  evidenceDigest?: string;
  humanHmac?: string;
}

export function foldLifecycle(events: LifecycleEvent[]): StrategyState {
  if (events.length === 0) return 'draft';
  
  let currentState: StrategyState = 'draft';
  for (const event of events) {
    if (event.eventType === 'transition') {
      if (!isValidTransition(currentState, event.toState)) {
        throw new Error(`INVALID_TRANSITION: ${currentState} -> ${event.toState}`);
      }
      currentState = event.toState;
    } else if (event.eventType === 'system_stale') {
      currentState = 'stale';
    }
    // stale_candidate does not change state, only records evidence
  }
  return currentState;
}

/**
 * CRITICAL BOUNDARY: strategy_field_verified vs competency field_verified
 * 
 * strategy_field_verified is a reproducibility state for the strategy.
 * It does NOT auto-count toward @sangfor/competency replacementRate.
 * 
 * To count toward replacementRate, a separate WorkAtom must be promoted
 * to field_verified with coveredBy pointing to a registered tool and
 * evidence pointing to an EXISTING regular file path inside evidence root.
 * 
 * This module does NOT perform automatic ledger writes.
 */
export function isCompetencyCountingState(state: StrategyState): boolean {
  // NONE of the strategy states auto-count toward competency
  return false;
}

export function requiresSeparateWorkAtomPromotion(state: StrategyState): boolean {
  // strategy_field_verified requires separate WorkAtom promotion for competency counting
  return state === 'strategy_field_verified';
}
