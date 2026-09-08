import { createHash } from 'node:crypto';
import { buildAuditEvent } from '../audit.js';
import type { AuthorityDatabase, SqlExecutor } from '../authority-store-contracts.js';
import { AuthorityCutoverError } from './errors.js';
import { AggregatePostgresTarget, type TargetScope } from './postgres-target-base.js';
import { auditSchema, deviceSchema, playbookSchema, runSchema, vendorSchema } from './source-schemas.js';
import { checkpointRecords, insertExactPayloadRecord, parseEnvelope, recordEnvelope, stableTargetId } from './target-common.js';
import { canonicalRecordSet } from './records.js';
import type { CutoverRecord } from './types.js';

export class RegistryCutoverTarget extends AggregatePostgresTarget {
  readonly aggregate = 'registry_services' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){
    if(r.provenance.source.endsWith('devices.json')){const d=deviceSchema.parse(r.payload);const envelope=recordEnvelope(r);const found=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;name:string;product:string;host:string;metadata:string|unknown}>>(`SELECT "tenantId","projectId","name","product","host","metadata" FROM "BlroDevice" WHERE "id"=$1`,d.id);if(found[0]){if(found[0].tenantId!==this.scope.tenantId||found[0].projectId!==this.scope.projectId||found[0].name!==d.name||found[0].product!==d.product||found[0].host!==d.host)throw new AuthorityCutoverError('TARGET_KEY_CONFLICT');const stored=parseEnvelope(found[0].metadata);if(canonicalRecordSet([stored]).digest!==canonicalRecordSet([r]).digest)throw new AuthorityCutoverError('TARGET_KEY_CONFLICT');return;}await tx.$executeRawUnsafe(`INSERT INTO "BlroDevice" ("id","tenantId","projectId","createdByActorId","name","product","host","metadata","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,$10::timestamptz)`,d.id,this.scope.tenantId,this.scope.projectId,this.scope.actorId,d.name,d.product,d.host,envelope,d.createdAt,d.updatedAt);return;}
    if(r.provenance.source.endsWith('vendors.json'))vendorSchema.parse(r.payload);else playbookSchema.parse(r.payload);await insertExactPayloadRecord(tx,'BlroServiceRegistry',{id:stableTargetId(this.aggregate,r.key),tenantId:this.scope.tenantId,projectId:this.scope.projectId,kind:'cutover:registry_services',record:r});
  }
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{value:unknown}>>(`SELECT "metadata" AS value FROM "BlroDevice" WHERE "projectId"=$1 AND "metadata" ? 'cutoverRecord' UNION ALL SELECT "payload" AS value FROM "BlroServiceRegistry" WHERE "projectId"=$1 AND "kind"='cutover:registry_services'`,p);return rows.map(r=>parseEnvelope(r.value));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroDevice" WHERE "projectId"=$1 AND "metadata" ? 'cutoverRecord'`,p);await tx.$executeRawUnsafe(`DELETE FROM "BlroServiceRegistry" WHERE "projectId"=$1 AND "kind"='cutover:registry_services'`,p);}
}

export class RunsCutoverTarget extends AggregatePostgresTarget {
  readonly aggregate = 'runs_steps' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){
    const parsed=runSchema.safeParse(r.payload);const runId=parsed.success?parsed.data.runId:stableTargetId('analysis-parent',r.key);const status=parsed.success?parsed.data.status:'succeeded';
    await tx.$executeRawUnsafe(`INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem","authorityEpoch") VALUES ($1,$2,$3,$4,$5,'legacy-v1','cutover:runs_steps',(SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$3)) ON CONFLICT ("id") DO NOTHING`,runId,this.scope.tenantId,this.scope.projectId,this.scope.actorId,status);
    const parents=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;actorId:string;status:string;toolProfileVersion:string;sourceSystem:string}>>(`SELECT "tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem" FROM "BlroRun" WHERE "id"=$1`,runId);const parent=parents[0];if(!parent||parent.tenantId!==this.scope.tenantId||parent.projectId!==this.scope.projectId||parent.actorId!==this.scope.actorId||parent.status!==status||parent.toolProfileVersion!=='legacy-v1'||parent.sourceSystem!=='cutover:runs_steps')throw new AuthorityCutoverError('TARGET_KEY_CONFLICT');
    const stepId=stableTargetId(this.aggregate,r.key);await tx.$executeRawUnsafe(`INSERT INTO "BlroRunStep" ("id","tenantId","projectId","runId","actorId","ordinal","status","payload") VALUES ($1,$2,$3,$4,$5,-1,$6,$7::jsonb) ON CONFLICT ("id") DO NOTHING`,stepId,this.scope.tenantId,this.scope.projectId,runId,this.scope.actorId,status,recordEnvelope(r));
    const steps=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;runId:string;actorId:string;ordinal:number;status:string;payload:unknown}>>(`SELECT "tenantId","projectId","runId","actorId","ordinal","status","payload" FROM "BlroRunStep" WHERE "id"=$1`,stepId);const step=steps[0];if(!step||step.tenantId!==this.scope.tenantId||step.projectId!==this.scope.projectId||step.runId!==runId||step.actorId!==this.scope.actorId||step.ordinal!==-1||step.status!==status||canonicalRecordSet([parseEnvelope(step.payload)]).digest!==canonicalRecordSet([r]).digest)throw new AuthorityCutoverError('TARGET_KEY_CONFLICT');
  }
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroRunStep" WHERE "projectId"=$1 AND "payload" ? 'cutoverRecord'`,p);return rows.map(r=>parseEnvelope(r.payload));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroRunStep" WHERE "projectId"=$1 AND "payload" ? 'cutoverRecord'`,p);await tx.$executeRawUnsafe(`DELETE FROM "BlroRun" WHERE "projectId"=$1 AND "sourceSystem"='cutover:runs_steps'`,p);}
}

export class AuditCutoverTarget extends AggregatePostgresTarget {
  readonly aggregate = 'audit' as const;
  constructor(database:AuthorityDatabase,scope:TargetScope,private readonly secret:string){super(database,scope);if(!secret)throw new AuthorityCutoverError('CUTOVER_AUDIT_SECRET_REQUIRED');}
  protected async upsertProduct():Promise<void>{throw new AuthorityCutoverError('CUTOVER_AUDIT_BATCH_REQUIRED');}
  override async stage(input:{readonly projectId:string;readonly highWaterMark:string;readonly records:readonly CutoverRecord[]}){
    await this.database.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,input.projectId);await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,input.projectId,this.aggregate);const found=await tx.$queryRawUnsafe<Array<{count:bigint|number}>>(`SELECT count(*) AS count FROM "BlroAuditEvent" WHERE "projectId"=$1 AND "kind" LIKE 'legacy.%'`,input.projectId);if(Number(found[0]?.count??0)===0)await this.writeBatch(tx,input.records);await checkpointRecords(tx,{...input,aggregate:this.aggregate});},{isolationLevel:'Serializable'});
  }
  private async writeBatch(tx:SqlExecutor,records:readonly CutoverRecord[]){const heads=await tx.$queryRawUnsafe<Array<{seq:bigint|number;hash:string}>>(`SELECT "seq","hash" FROM "BlroAuditEvent" WHERE "projectId"=$1 ORDER BY "seq" DESC LIMIT 1`,this.scope.projectId);let seq=heads[0]?Number(heads[0].seq)+1:0;let previous=heads[0]?.hash??'GENESIS';for(const r of [...records].sort((a,b)=>a.key.localeCompare(b.key))){const source=auditSchema.parse(r.payload);const event=buildAuditEvent({projectId:this.scope.projectId,seq,kind:`legacy.${source.kind}`,payload:{cutoverRecord:r},prevHash:previous,actorId:this.scope.actorId},this.secret);await tx.$executeRawUnsafe(`INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","at","actorId","kind","payload","prevHash","hash","keyed") VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9,$10,$11)`,stableTargetId(this.aggregate,r.key),this.scope.tenantId,this.scope.projectId,seq,source.at,this.scope.actorId,event.kind,JSON.stringify(event.payload),previous,event.hash,event.keyed);seq++;previous=event.hash;}}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{payload:unknown}>>(`SELECT "payload" FROM "BlroAuditEvent" WHERE "projectId"=$1 AND "kind" LIKE 'legacy.%'`,p);return rows.map(r=>parseEnvelope(r.payload));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroAuditEvent" WHERE "projectId"=$1 AND "kind" LIKE 'legacy.%'`,p);}
}

export class EvidenceCutoverTarget extends AggregatePostgresTarget {
  readonly aggregate='evidence' as const;
  protected async upsertProduct(tx:SqlExecutor,r:CutoverRecord){const runId=stableTargetId('evidence-parent',r.key);await tx.$executeRawUnsafe(`INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem","authorityEpoch") VALUES ($1,$2,$3,$4,'succeeded','legacy-v1','cutover:evidence',(SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$3)) ON CONFLICT ("id") DO NOTHING`,runId,this.scope.tenantId,this.scope.projectId,this.scope.actorId);await tx.$executeRawUnsafe(`INSERT INTO "BlroEvidenceManifest" ("id","tenantId","projectId","actorId","runId","contentHash","manifest") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT ("id") DO NOTHING`,stableTargetId(this.aggregate,r.key),this.scope.tenantId,this.scope.projectId,this.scope.actorId,runId,createHash('sha256').update(r.key).digest('hex'),recordEnvelope(r));}
  protected async readProduct(tx:SqlExecutor,p:string){const rows=await tx.$queryRawUnsafe<Array<{manifest:unknown}>>(`SELECT "manifest" FROM "BlroEvidenceManifest" WHERE "projectId"=$1 AND "manifest" ? 'cutoverRecord'`,p);return rows.map(r=>parseEnvelope(r.manifest));}
  protected async cleanupProduct(tx:SqlExecutor,p:string){await tx.$executeRawUnsafe(`DELETE FROM "BlroEvidenceManifest" WHERE "projectId"=$1 AND "manifest" ? 'cutoverRecord'`,p);await tx.$executeRawUnsafe(`DELETE FROM "BlroRun" WHERE "projectId"=$1 AND "sourceSystem"='cutover:evidence'`,p);}
}
