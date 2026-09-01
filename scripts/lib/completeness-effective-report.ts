import type { EffectiveCoverageResult } from '../../packages/sangfor-competency/src/index.js';

export type EffectiveReportOutput = {
  readonly strict: boolean;
  readonly json: boolean;
};

export function renderEffectiveCoverage(
  result: EffectiveCoverageResult,
  output: EffectiveReportOutput,
): number {
  if (!result.ok) {
    if (output.json) process.stdout.write(`${JSON.stringify({ ok: false, violations: result.violations }, null, 2)}\n`);
    else {
      process.stdout.write(`project completeness: MEASUREMENT REFUSED (${result.violations.length} violation(s))\n`);
      for (const violation of result.violations) {
        process.stdout.write(`  - [${violation.kind}] ${violation.atomId ?? '<catalog>'}: ${violation.detail}\n`);
      }
    }
    return output.strict ? 1 : 0;
  }

  const { report } = result;
  if (output.json) process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
  else {
    process.stdout.write(
      `project completeness: ${(report.replacementRate * 100).toFixed(1)}% ` +
      `(${report.replacedAtoms}/${report.automatableAtoms} automatable replaced, ` +
      `${report.humanOnlyAtoms} human-only, ${report.totalAtoms} total)\n`,
    );
    for (const issue of report.claimIssues) {
      process.stdout.write(
        `  - [${issue.state}] ${issue.atomId}: effective maturity ${issue.effectiveMaturity}` +
        `${issue.evidenceIssueCodes.length === 0 ? '' : ` (${issue.evidenceIssueCodes.join(', ')})`}\n`,
      );
    }
  }
  return 0;
}
