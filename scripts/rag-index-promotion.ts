import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { evaluateIndexPromotion, parseIndexPromotionReport } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { IndexPromotionStore } from '../packages/sangfor-rag/src/index-promotion-store.js';
import { parsePgvectorScope } from '../packages/sangfor-rag/src/pgvector-schema.js';

const EnvironmentSchema = z.object({ DATABASE_URL: z.string().url() }).passthrough();
const ArgsSchema = z.object({
  report: z.string().min(1).optional(), actorId: z.string().min(1), apply: z.boolean(), status: z.boolean(),
  demote: z.boolean(), reason: z.string().min(1), help: z.boolean(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

const HELP = `Usage: rag-index-promotion [--report PATH] [--actor-id ID] [--apply|--status|--demote] [--reason TEXT]

Evaluate is dry-run by default. --apply is required to persist a promotion.
`;

function parseArgs(argv: readonly string[]): Args {
  const values: { report?: string; actorId: string; apply: boolean; status: boolean; demote: boolean; reason: string; help: boolean } = {
    actorId: 'rag-index-promotion-owner', apply: false, status: false, demote: false, reason: 'owner-approved benchmark', help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help') values.help = true;
    else if (argument === '--apply') values.apply = true;
    else if (argument === '--status') values.status = true;
    else if (argument === '--demote') values.demote = true;
    else if (argument === '--report' || argument === '--actor-id' || argument === '--reason') {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`RAG_INDEX_PROMOTION_ARGUMENT_VALUE_REQUIRED: ${argument}`);
      if (argument === '--report') values.report = next;
      else if (argument === '--actor-id') values.actorId = next;
      else values.reason = next;
      index += 1;
    } else throw new TypeError(`RAG_INDEX_PROMOTION_ARGUMENT_UNSUPPORTED: ${argument}`);
  }
  if ([values.apply, values.status, values.demote].filter(Boolean).length > 1) throw new TypeError('RAG_INDEX_PROMOTION_MODE_AMBIGUOUS');
  if (!values.help && !values.status && !values.demote && !values.report) throw new TypeError('RAG_INDEX_PROMOTION_REPORT_REQUIRED');
  return ArgsSchema.parse(values);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  const environment = EnvironmentSchema.parse(process.env);
  const database = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  try {
    const store = new IndexPromotionStore(database);
    if (args.status || args.demote) {
      const report = args.report ? parseIndexPromotionReport(JSON.parse(readFileSync(args.report, 'utf8'))) : null;
      const tenantId = report?.tenantId ?? process.env['SANGFOR_TENANT_ID'];
      const projectId = report?.projectId ?? process.env['SANGFOR_PROJECT_ID'];
      const scope = parsePgvectorScope({ tenantId, projectId, actorId: args.actorId });
      if (args.demote) { await store.demote(scope, args.reason); process.stdout.write('RAG_INDEX_PROMOTION_DEMOTED\n'); return; }
      process.stdout.write(`${JSON.stringify(await store.loadPromotion(scope))}\n`); return;
    }
    const report = parseIndexPromotionReport(JSON.parse(readFileSync(args.report ?? '', 'utf8')));
    const expectedTenant = process.env['SANGFOR_TENANT_ID'];
    const expectedProject = process.env['SANGFOR_PROJECT_ID'];
    if ((expectedTenant && expectedTenant !== report.tenantId) || (expectedProject && expectedProject !== report.projectId)) {
      process.stdout.write(`${JSON.stringify({ eligible: false, reason: 'PROMOTION_SCOPE_MISMATCH' })}\nRAG_INDEX_PROMOTION_REFUSED\n`);
      process.exitCode = 2;
      return;
    }
    const scope = parsePgvectorScope({ tenantId: report.tenantId, projectId: report.projectId, actorId: args.actorId });
    const evaluation = evaluateIndexPromotion(report, await store.readCurrentState(scope), new Date());
    if (!evaluation.eligible) { process.stdout.write(`${JSON.stringify(evaluation)}\nRAG_INDEX_PROMOTION_REFUSED\n`); process.exitCode = 2; return; }
    if (args.apply) await store.apply({ scope, report, now: new Date(), reason: args.reason });
    process.stdout.write(`${JSON.stringify({ ...evaluation, applied: args.apply })}\nRAG_INDEX_PROMOTION_PASS\n`);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => { // no-excuse-ok: catch -- CLI process boundary
  process.stderr.write(`${error instanceof Error ? error.message : 'RAG_INDEX_PROMOTION_UNKNOWN_FAILURE'}\n`);
  process.exitCode = 1;
});
