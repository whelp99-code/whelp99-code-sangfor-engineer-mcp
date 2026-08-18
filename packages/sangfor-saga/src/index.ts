/**
 * @sangfor/saga — PM saga coordinator (design 002, block F3).
 *
 * Two pure functions over injected state: `tick` decides what may run now
 * (device exclusivity, lease reclamation, input-supplied budgets) and
 * `mergeReports` reduces the resulting engineer reports structurally while
 * escalating — never arbitrating — prose and verdict disagreements.
 *
 * The coordinator itself performs no IO: appending to the report ledger is the
 * caller's job via @sangfor/engineer-report.
 */
export {
  tick,
  type BudgetSpec,
  type Lease,
  type OpenFinding,
  type TickInput,
  type WorkItem,
  type WorkItemBudget,
} from './tick.js';
export {
  mergeReports,
  type EscalationReason,
  type MergeEscalation,
  type MergedReports,
  type ReportForFinding,
} from './merge.js';
