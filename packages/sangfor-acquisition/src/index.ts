/**
 * @sangfor/acquisition — collection speed and reliability primitives
 * (design 002, blocks C1, C3, A5).
 *
 * L1 package: pure data in, pure data out. No transport, no sockets, no clock
 * reads inside the decision functions — callers inject `now`, budgets, ledgers
 * and registries so every decision is replayable from a run ledger.
 */
export {
  enqueueTargetedRecollect,
  parsePassiveEvent,
  type DeviceRegistry,
  type EnqueueOptions,
  type PassiveEvent,
  type PassiveEventKind,
  type PassiveSeverity,
  type RecollectEntry,
  type RecollectQueue,
  type UnmatchedPassiveEvent,
} from './passive.js';
export {
  COLLECTION_PROFILES,
  getProfile,
  selectIncremental,
  selectProfile,
  type CollectionProfile,
  type CollectionProfileName,
  type CollectionTrigger,
  type SelectIncrementalInput,
  type SelectProfileInput,
} from './profiles.js';
export {
  planCalls,
  type ApiBudget,
  type CallLedger,
  type CallPlan,
  type CollectionLoadRecord,
  type PlanCallsInput,
  type PlannedCall,
} from './budget.js';
