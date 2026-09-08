/**
 * CI gate: the GitHub program graph must match what the parent issue declares.
 *
 * Live mode shells out to `gh` read-only (`issue list` / `pr list`); offline mode
 * reads a committed fixture so CI and reviewers can exercise the failure shapes
 * without a token. Either way the JSON crosses the trust boundary exactly once,
 * through `parseTrackerSnapshot`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateTrackerTruth, parseTrackerSnapshot, type TrackerReport, type TrackerSnapshot } from './lib/tracker-truth.js';

const DEFAULT_REPO = 'whelp99-code/whelp99-code-sangfor-engineer-mcp';
const GH_LIMIT = '200';

type CliOptions = {
  readonly offlineFixture: string | undefined;
  readonly repo: string;
  readonly json: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    offlineFixture: valueOf('--offline-fixture'),
    repo: valueOf('--repo') ?? process.env.TRACKER_REPO ?? DEFAULT_REPO,
    json: argv.includes('--json'),
  };
}

function gh(args: readonly string[]): string {
  return execFileSync('gh', [...args], { encoding: 'utf8', maxBuffer: 32_000_000 });
}

function fetchLiveSnapshot(repo: string): TrackerSnapshot {
  const issues = gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', GH_LIMIT, '--json', 'number,state,title,createdAt,labels,body', '--jq', '[.[] | {number, state, title, createdAt, labels: [.labels[].name], body}]']);
  const pullRequests = gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', GH_LIMIT, '--json', 'number,state,createdAt,body', '--jq', '[.[] | {number, state, createdAt, body}]']);
  return parseTrackerSnapshot(JSON.stringify({ version: 1, issues: JSON.parse(issues), pullRequests: JSON.parse(pullRequests) }));
}

function render(report: TrackerReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ marker: report.ok ? 'TRACKER_TRUTH_PASS' : 'TRACKER_TRUTH_FAIL', ...report }, null, 2)}\n`);
    return;
  }
  if (report.ok) {
    process.stdout.write(`TRACKER_TRUTH_PASS: parent #${String(report.parentIssue)} with ${report.childIssues.length} children\n`);
    return;
  }
  process.stdout.write(`TRACKER_TRUTH_FAIL: ${report.violations.length} violation(s)\n`);
  for (const violation of report.violations) {
    process.stdout.write(`  - [${violation.code}] ${violation.detail}\n`);
  }
}

function main(): number { // no-excuse-ok: catch
  const options = parseArgs(process.argv.slice(2));
  try {
    const snapshot = options.offlineFixture === undefined
      ? fetchLiveSnapshot(options.repo)
      : parseTrackerSnapshot(readFileSync(options.offlineFixture, 'utf8'));
    const report = evaluateTrackerTruth(snapshot);
    render(report, options.json);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`TRACKER_TRUTH_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

process.exit(main());
