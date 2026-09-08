import type { SqlExecutor } from '../authority-store-contracts.js';
import { AggregatePostgresTarget } from './postgres-target-base.js';
import { insertExactPayloadRecord, parseEnvelope, stableTargetId } from './target-common.js';
import type { CutoverRecord } from './types.js';

abstract class JsonAggregateTarget extends AggregatePostgresTarget {
  protected envelope(row: { readonly payload: unknown }): CutoverRecord { return parseEnvelope(row.payload); }
}

export class PmTaskCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'pm_tasks' as const;
  protected async upsertProduct(tx: SqlExecutor, r: CutoverRecord) { await insertExactPayloadRecord(tx,'BlroPmRecord',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:pm_tasks',record:r}); }
  protected async readProduct(tx: SqlExecutor,p:string) { const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroPmRecord" WHERE "projectId"=$1 AND "kind"='cutover:pm_tasks'`,p); return rows.map(r=>this.envelope(r)); }
  protected async cleanupProduct(tx: SqlExecutor,p:string) { await tx.$executeRawUnsafe(`DELETE FROM "BlroPmRecord" WHERE "projectId"=$1 AND "kind"='cutover:pm_tasks'`,p); }
}
export class FeedbackCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'feedback_lessons' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroFeedbackLesson',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:feedback_lessons',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroFeedbackLesson" WHERE "projectId"=$1 AND "kind"='cutover:feedback_lessons'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroFeedbackLesson" WHERE "projectId"=$1 AND "kind"='cutover:feedback_lessons'`,p);}
}
export class EvalCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'evals' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroEvalRecord',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:evals',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroEvalRecord" WHERE "projectId"=$1 AND "kind"='cutover:evals'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroEvalRecord" WHERE "projectId"=$1 AND "kind"='cutover:evals'`,p);}
}
export class WikiCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'wiki_proposals' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroWikiProposal',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:wiki_proposals',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroWikiProposal" WHERE "projectId"=$1 AND "kind"='cutover:wiki_proposals'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroWikiProposal" WHERE "projectId"=$1 AND "kind"='cutover:wiki_proposals'`,p);}
}
export class LearningCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'learning_strategy_lifecycle' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroLearningRecord',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:learning_strategy_lifecycle',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroLearningRecord" WHERE "projectId"=$1 AND "kind"='cutover:learning_strategy_lifecycle'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroLearningRecord" WHERE "projectId"=$1 AND "kind"='cutover:learning_strategy_lifecycle'`,p);}
}
export class ChronicleCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'config_chronicle_state' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroConfigChronicle',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:config_chronicle_state',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroConfigChronicle" WHERE "projectId"=$1 AND "kind"='cutover:config_chronicle_state'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroConfigChronicle" WHERE "projectId"=$1 AND "kind"='cutover:config_chronicle_state'`,p);}
}
export class CapabilityCutoverTarget extends JsonAggregateTarget {
  readonly aggregate = 'capability_evidence_promotion' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){await insertExactPayloadRecord(tx,'BlroCapabilityEvidence',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:capability_evidence_promotion',record:r});}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroCapabilityEvidence" WHERE "projectId"=$1 AND "kind"='cutover:capability_evidence_promotion'`,p);return rows.map(r=>this.envelope(r));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroCapabilityEvidence" WHERE "projectId"=$1 AND "kind"='cutover:capability_evidence_promotion'`,p);}
}
