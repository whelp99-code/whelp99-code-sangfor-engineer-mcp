import { ConfigPlan } from '@sangfor/shared';

export function generateEvidenceReport(input: { plan: ConfigPlan; verification?: unknown; format?: 'markdown' | 'json' }) {
  const plan = input.plan;
  const md = [
    `# Sangfor Evidence Report`,
    ``,
    `## Project`,
    `- Customer: ${plan.customerName}`,
    `- Product: ${plan.product}`,
    `- Version: ${plan.version ?? 'not specified'}`,
    `- Risk: ${plan.riskLevel}`,
    ``,
    `## Plan Summary`,
    plan.planSummary,
    ``,
    `## Precheck`,
    ...plan.precheck.map(s => `- [ ] ${s.title}: ${s.description}`),
    ``,
    `## Configuration Steps`,
    ...plan.steps.map(s => `- ${s.approvalRequired ? '[APPROVAL REQUIRED]' : '[DRY-RUN OK]'} ${s.title}: ${s.description}`),
    ``,
    `## Rollback Plan`,
    ...plan.rollbackPlan.map(s => `- ${s.title}: ${s.description}`),
    ``,
    `## Validation Plan`,
    ...plan.validationPlan.map(s => `- [ ] ${s.title}: ${s.description}`),
    ``,
    `## References`,
    ...[...plan.manualReferences, ...plan.wikiReferences].map(ref => `- ${ref.sourceType}/${ref.product}: ${ref.title} > ${ref.section ?? 'n/a'}`),
    ``,
    `## Verification`,
    '```json',
    JSON.stringify(input.verification ?? {}, null, 2),
    '```'
  ].join('\n');
  return { format: input.format ?? 'markdown', content: md };
}
