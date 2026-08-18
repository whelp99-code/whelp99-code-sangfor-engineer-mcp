/**
 * @sangfor/chronicle — Config Chronicle (design 002, block B1).
 *
 * (1) A content-addressed snapshot store: one chain per device, sha256 over
 *     canonical JSON, parent links, write-time semantic diffs.
 * (2) An unapproved-drift read model that joins those diffs against injected
 *     change approvals.
 *
 * L1 package: may import only @sangfor/shared. Approval data arrives as
 * arguments so higher layers stay out of this dependency graph.
 */
export { canonicalize, semanticDiff, type ChangeClass, type SemanticChange } from './diff.js';
export {
  getDiff,
  getHead,
  listSnapshots,
  recordSnapshot,
  type ChronicleChain,
  type ChronicleSnapshot,
  type RecordSnapshotInput,
  type RecordSnapshotResult,
} from './store.js';
export {
  findUnapprovedDrift,
  type ChangeApproval,
  type FindUnapprovedDriftInput,
  type UnapprovedDriftFinding,
} from './drift.js';
