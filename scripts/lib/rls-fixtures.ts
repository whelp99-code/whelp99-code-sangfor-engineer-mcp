import { createHash } from 'node:crypto';

type SqlExecutor = {
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
};

export type RlsProjectFixture = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly roleId: string;
  readonly label: string;
};

async function execute(
  database: SqlExecutor,
  query: string,
  values: readonly unknown[],
): Promise<void> {
  await database.$executeRawUnsafe(query, ...values);
}

export async function seedRlsProject(database: SqlExecutor, fixture: RlsProjectFixture): Promise<void> {
  const { tenantId, projectId, actorId, roleId, label } = fixture;
  const digest = (kind: string): string => createHash('sha256').update(`${kind}:${label}`).digest('hex');
  await execute(database, `SELECT set_config('app.project_id',$1,true)`, [projectId]);
  const statements: readonly [string, readonly unknown[]][] = [
    [`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`, [projectId, tenantId, `RLS ${label}`]],
    [`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5)`, [`membership-${label}`, tenantId, projectId, actorId, roleId]],
    [`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") VALUES ($1,7,0)`, [projectId]],
    [`INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision") VALUES ($1,'evals','LOCAL_PRIMARY',7,0)`, [projectId]],
    [`INSERT INTO "BlroAuthorityCutoverStaging" ("projectId","aggregate","recordKey","highWaterMark","record","recordDigest") VALUES ($1,'evals',$2,'hwm','{}',$3)`, [projectId, `staging-${label}`, digest('staging')]],
    [`INSERT INTO "BlroSourceRootOwner" ("sourceDevice","sourceInode","tenantId","projectId","sourceRoot") VALUES ($1,$2,$3,$4,$5)`, [`source-device-${label}`, `source-inode-${label}`, tenantId, projectId, `/tmp/${label}`]],
    [`INSERT INTO "BlroLocalWriteIntent" ("writeId","tenantId","projectId","actorId","aggregate","epoch","sourceRoot","operationDigest","targetPaths","beforeDigests","status") VALUES ($1,$2,$3,$4,'evals',7,$5,$6,'[]','{}','PENDING')`, [`intent-${label}`, tenantId, projectId, actorId, `/tmp/${label}`, digest('intent')]],
    [`INSERT INTO "BlroApprovalNonce" ("id","tenantId","projectId","nonce","expiresAt","consumedAt","authorityEpoch") VALUES ($1,$2,$3,$4,now()+interval '1 hour',now(),7)`, [`nonce-${label}`, tenantId, projectId, `nonce-value-${label}`]],
    [`INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","actorId","kind","payload","prevHash","hash") VALUES ($1,$2,$3,0,$4,'rls.probe','{}','GENESIS',$5)`, [`audit-${label}`, tenantId, projectId, actorId, `hash-${label}`]],
    [`INSERT INTO "BlroDevice" ("id","tenantId","projectId","createdByActorId","name","product","host","metadata") VALUES ($1,$2,$3,$4,$5,'probe','127.0.0.1','{}')`, [`device-${label}`, tenantId, projectId, actorId, `device-${label}`]],
    [`INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem","authorityEpoch") VALUES ($1,$2,$3,$4,'created','probe-v1','rls',7)`, [`run-${label}`, tenantId, projectId, actorId]],
    [`INSERT INTO "BlroRunStep" ("id","tenantId","projectId","runId","actorId","ordinal","status","payload") VALUES ($1,$2,$3,$4,$5,0,'created','{}')`, [`step-${label}`, tenantId, projectId, `run-${label}`, actorId]],
    [`INSERT INTO "BlroApproval" ("id","tenantId","projectId","actorId","actionHash","expiresAt","status","authorityEpoch") VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour','approved',7)`, [`approval-${label}`, tenantId, projectId, actorId, `action-${label}`]],
    [`INSERT INTO "BlroEvidenceManifest" ("id","tenantId","projectId","actorId","runId","contentHash","manifest") VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [`evidence-${label}`, tenantId, projectId, actorId, `run-${label}`, `evidence-${label}`]],
    [`INSERT INTO "BlroRagDocument" ("id","tenantId","projectId","actorId","title","sourceRef","contentHash","provenance") VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')`, [`document-${label}`, tenantId, projectId, actorId, label, `probe:${label}`, `document-${label}`]],
    [`INSERT INTO "BlroRagChunk" ("id","tenantId","projectId","documentId","text","contentHash","aclActorIds") VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [`chunk-${label}`, tenantId, projectId, `document-${label}`, label, `chunk-${label}`]],
    [`INSERT INTO "BlroRagEmbeddingCohort" ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","active") VALUES ($1,$2,$3,33,'hash','hash-v1',384,true)`, [`cohort-${label}`, tenantId, projectId]],
    [`INSERT INTO "BlroRagAuthoritativeChunk" ("id","tenantId","projectId","actorId","product","version","sourceType","trustLevel","title","text","sourceRef","contentHash","aclActorIds") VALUES ($1,$2,$3,$4,'HCI','1.0','manual','official',$5,$6,$7,$8,'{}')`, [`native-chunk-${label}`, tenantId, projectId, actorId, label, label, `probe:${label}`, `native-hash-${label}`]],
    [`INSERT INTO "BlroRagEmbedding" ("tenantId","projectId","chunkId","cohortId","product","version","sourceType","trustLevel","aclActorIds","embedding") VALUES ($1,$2,$3,$4,'HCI','1.0','manual','official','{}',$5::vector)`, [tenantId, projectId, `native-chunk-${label}`, `cohort-${label}`, `[1,${Array.from({ length: 383 }, () => 0).join(',')}]`]],
    [`INSERT INTO "BlroClientEnrollment" ("id","tenantId","projectId","installationId","certificateSerial","record") VALUES ($1,$2,$3,$4,$5,'{}')`, [`client-enrollment-${label}`, tenantId, projectId, `client-install-${label}`, `client-serial-${label}`]],
    [`INSERT INTO "BlroEnrollmentIdentity" ("id","tenantId","projectId","installationId","deviceBindingDigest","clientIdentityId","state","revision","currentCertificateSerial","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,now(),now())`, [`enrollment-${label}`, tenantId, projectId, `install-${label}`, digest('device'), `client-${label}`, `serial-${label}`]],
    [`INSERT INTO "BlroEnrollmentCertificate" ("id","tenantId","projectId","enrollmentId","issuerChainRef","issuer","subjectAltNames","extendedKeyUsages","serial","fingerprintSha256","notBefore","notAfter","state","revision","createdAt") VALUES ($1,$2,$3,$4,$5,'CN=RLS',ARRAY[$6,$6 || ':device'],ARRAY['1.3.6.1.5.5.7.3.2'],$7,$8,now()-interval '1 minute',now()+interval '1 hour','active',1,now())`, [`certificate-${label}`, tenantId, projectId, `enrollment-${label}`, digest('issuer'), `urn:${label}`, `serial-${label}`, digest('fingerprint')]],
    [`INSERT INTO "BlroEnrollmentGrant" ("id","tenantId","projectId","enrollmentId","originDigest","scope","revision","createdAt") VALUES ($1,$2,$3,$4,$5,'browser:execute',1,now())`, [`grant-${label}`, tenantId, projectId, `enrollment-${label}`, digest('origin')]],
    [`INSERT INTO "BlroEnrollmentBootstrapToken" ("id","tenantId","projectId","installationId","deviceBindingDigest","tokenDigest","grants","expiresAt","revision","createdAt") VALUES ($1,$2,$3,$4,$5,$6,'[]',now()+interval '1 hour',0,now())`, [`bootstrap-${label}`, tenantId, projectId, `bootstrap-install-${label}`, digest('bootstrap-device'), digest('token')]],
    [`INSERT INTO "BlroEnrollmentRotation" ("id","tenantId","projectId","enrollmentId","oldSerial","newSerial","overlapExpiresAt","requestDigest","revision","createdAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',$7,2,now())`, [`rotation-${label}`, tenantId, projectId, `enrollment-${label}`, `old-${label}`, `serial-${label}`, digest('rotation')]],
    [`INSERT INTO "BlroRemoteJobCapabilityJti" ("jti","tenantId","projectId","installationId","jobId","requestDigest","capabilityExpiresAt","consumedAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`, [`jti-${label}`, tenantId, projectId, `install-${label}`, `job-${label}`, digest('request')]],
    [`INSERT INTO "BlroRemoteJob" ("id","tenantId","projectId","installationId","jobId","runId","stepId","requestId","requestDigest","capabilityJti","state","authorityEpoch","tombstoneCommittedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dispatch_committed',7,now(),now(),now())`, [`remote-${label}`, tenantId, projectId, `install-${label}`, `job-${label}`, `remote-run-${label}`, `remote-step-${label}`, `request-${label}`, digest('request'), `jti-${label}`]],
  ];
  for (const [query, values] of statements) await execute(database, query, values);
  for (const table of ['BlroServiceRegistry', 'BlroPmRecord', 'BlroFeedbackLesson', 'BlroEvalRecord', 'BlroWikiProposal', 'BlroLearningRecord', 'BlroFirmwareEvidence', 'BlroConfigChronicle', 'BlroCapabilityEvidence'] as const) {
    await execute(database, `INSERT INTO "${table}" ("id","tenantId","projectId","kind","payload") VALUES ($1,$2,$3,'probe','{}')`, [`${table}-${label}`, tenantId, projectId]);
  }
  await execute(database, `INSERT INTO "BlroRagSourceChunk" ("id","tenantId","projectId","documentId","text","contentHash","aclActorIds") VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [`source-chunk-${label}`, tenantId, projectId, `source-document-${label}`, label, `source-hash-${label}`]);
}
