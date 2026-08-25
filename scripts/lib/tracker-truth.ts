/**
 * Tracker truth — the machine reading of the GitHub program graph.
 *
 * Every expectation is derived from the snapshot itself: the parent is the issue
 * carrying a `program:*` label, and the child set comes from the parent body's
 * Todo/Issue table. Nothing here hard-codes an issue number or a child count, so
 * the checker keeps telling the truth as the program grows. Issue and PR bodies
 * are untrusted external text: they are only ever scanned for structural tokens
 * (`#<number>`, evidence paths), never interpreted as instructions.
 */
import { z } from 'zod';
import { parseRuntimeJson, type RuntimeSchemaContract } from '../../packages/shared/src/runtime-schema.js';

const issueSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED']),
  title: z.string(),
  createdAt: z.string().min(1),
  labels: z.array(z.string()).readonly(),
  body: z.string(),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  createdAt: z.string().min(1),
  body: z.string(),
});

const snapshotSchema = z.object({
  version: z.literal(1),
  issues: z.array(issueSchema).readonly(),
  pullRequests: z.array(pullRequestSchema).readonly(),
});

export type TrackerIssue = z.infer<typeof issueSchema>;
export type TrackerPullRequest = z.infer<typeof pullRequestSchema>;
export type TrackerSnapshot = z.infer<typeof snapshotSchema>;

const SNAPSHOT_CONTRACT: RuntimeSchemaContract<TrackerSnapshot> = {
  schema: snapshotSchema,
  schemaName: 'TrackerSnapshot',
  policy: 'loud_failure',
  expectedVersion: 1,
};

export type TrackerViolation =
  | { readonly code: 'parent_missing'; readonly detail: string }
  | { readonly code: 'parent_ambiguous'; readonly detail: string }
  | { readonly code: 'parent_table_empty'; readonly issue: number; readonly detail: string }
  | { readonly code: 'child_missing'; readonly issue: number; readonly detail: string }
  | { readonly code: 'child_orphan'; readonly issue: number; readonly detail: string }
  | { readonly code: 'status_label_missing'; readonly issue: number; readonly detail: string }
  | { readonly code: 'status_label_conflict'; readonly issue: number; readonly detail: string }
  | { readonly code: 'closed_without_evidence'; readonly issue: number; readonly detail: string }
  | { readonly code: 'pull_request_without_issue'; readonly pullRequest: number; readonly detail: string }
  | { readonly code: 'pull_request_issue_unknown'; readonly pullRequest: number; readonly detail: string };

export type TrackerReport = {
  readonly ok: boolean;
  readonly parentIssue: number | undefined;
  readonly childIssues: readonly number[];
  readonly violations: readonly TrackerViolation[];
};

/** `| 4 | #33 | title | deps | domains |` rows in the parent program body. */
const CHILD_ROW = /^\|\s*(\d+)\s*\|\s*#(\d+)\s*\|/gm;
const CLOSING_REFERENCE = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi;
const EVIDENCE_PATH = /\.omo\/evidence\/[\w./-]+\.json/;
const RUNTIME_LABELS = new Set(['ready-for-blro', 'blro', 'ops']);
const STATUS_PREFIX = 'status:';
const PROGRAM_PREFIX = 'program:';

export function parseTrackerSnapshot(source: string): TrackerSnapshot {
  return parseRuntimeJson(source, SNAPSHOT_CONTRACT);
}

function parentChildTable(body: string): ReadonlyMap<number, number> {
  const rows = new Map<number, number>();
  for (const match of body.matchAll(CHILD_ROW)) {
    const todo = Number(match[1]);
    const issue = Number(match[2]);
    if (Number.isInteger(todo) && Number.isInteger(issue)) rows.set(todo, issue);
  }
  return rows;
}

function statusLabels(issue: TrackerIssue): readonly string[] {
  return issue.labels.filter((label) => label.startsWith(STATUS_PREFIX));
}

function checkStatusLabels(issue: TrackerIssue): TrackerViolation | undefined {
  if (issue.state === 'CLOSED') return undefined;
  const statuses = statusLabels(issue);
  if (statuses.length === 0) {
    return { code: 'status_label_missing', issue: issue.number, detail: 'open issue carries 0 status:* labels' };
  }
  if (statuses.length > 1) {
    return {
      code: 'status_label_conflict',
      issue: issue.number,
      detail: `open issue carries ${statuses.length} status:* labels: ${[...statuses].sort().join(', ')}`,
    };
  }
  return undefined;
}

function checkClosedEvidence(issue: TrackerIssue): TrackerViolation | undefined {
  const runtimeScoped = issue.labels.some((label) => RUNTIME_LABELS.has(label));
  if (issue.state !== 'CLOSED' || !runtimeScoped || EVIDENCE_PATH.test(issue.body)) return undefined;
  return { code: 'closed_without_evidence', issue: issue.number, detail: 'closed runtime issue records no .omo/evidence/ path' };
}

function checkChild(child: TrackerIssue, parent: TrackerIssue): readonly TrackerViolation[] {
  const violations: TrackerViolation[] = [];
  if (!new RegExp(`#${parent.number}\\b`).test(child.body)) {
    violations.push({ code: 'child_orphan', issue: child.number, detail: `child does not reference parent #${parent.number}` });
  }
  const status = checkStatusLabels(child);
  if (status !== undefined) violations.push(status);
  const evidence = checkClosedEvidence(child);
  if (evidence !== undefined) violations.push(evidence);
  return violations;
}

function checkPullRequest(
  pullRequest: TrackerPullRequest,
  graph: ReadonlySet<number>,
  contractStart: number,
): readonly TrackerViolation[] {
  if (Date.parse(pullRequest.createdAt) < contractStart) return [];
  const closed = [...pullRequest.body.matchAll(CLOSING_REFERENCE)].map((match) => Number(match[1]));
  if (closed.length === 0) {
    return [{
      code: 'pull_request_without_issue',
      pullRequest: pullRequest.number,
      detail: 'PR opened under the program contract has no "Closes #<issue>" reference',
    }];
  }
  return closed
    .filter((issue) => !graph.has(issue))
    .map((issue) => ({
      code: 'pull_request_issue_unknown' as const,
      pullRequest: pullRequest.number,
      detail: `PR closes #${issue} which is not the program parent or one of its children`,
    }));
}

export function evaluateTrackerTruth(snapshot: TrackerSnapshot): TrackerReport {
  const parents = snapshot.issues.filter((issue) => issue.labels.some((label) => label.startsWith(PROGRAM_PREFIX)));
  const parent = parents[0];
  if (parent === undefined) {
    return { ok: false, parentIssue: undefined, childIssues: [], violations: [{ code: 'parent_missing', detail: 'no issue carries a program:* label' }] };
  }
  if (parents.length > 1) {
    return {
      ok: false,
      parentIssue: parent.number,
      childIssues: [],
      violations: [{ code: 'parent_ambiguous', detail: `${parents.length} issues carry a program:* label: ${parents.map((p) => `#${p.number}`).join(', ')}` }],
    };
  }

  const table = parentChildTable(parent.body);
  if (table.size === 0) {
    return {
      ok: false,
      parentIssue: parent.number,
      childIssues: [],
      violations: [{ code: 'parent_table_empty', issue: parent.number, detail: 'parent body declares no "| todo | #issue |" child rows' }],
    };
  }

  const byNumber = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
  const violations: TrackerViolation[] = [];
  const childIssues: number[] = [];

  for (const [todo, number] of [...table].sort(([a], [b]) => a - b)) {
    const child = byNumber.get(number);
    if (child === undefined) {
      violations.push({ code: 'child_missing', issue: number, detail: `parent #${parent.number} lists Todo ${todo} as #${number} but no such issue exists` });
      continue;
    }
    childIssues.push(number);
    violations.push(...checkChild(child, parent));
  }

  const parentStatus = checkStatusLabels(parent);
  if (parentStatus !== undefined) violations.push(parentStatus);

  const graph = new Set([parent.number, ...childIssues]);
  const contractStart = Date.parse(parent.createdAt);
  for (const pullRequest of snapshot.pullRequests) {
    violations.push(...checkPullRequest(pullRequest, graph, contractStart));
  }

  return { ok: violations.length === 0, parentIssue: parent.number, childIssues, violations };
}
